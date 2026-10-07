# Continual learning

Status: **design for owner review; nothing here is implemented.**
Implementation waits until the owner's Mac Studios arrive (decided
2026-09-29).

**Goal for v1:** every ghost is a continual learning agent. It learns from
its own experience, the stream of what it observes, what it does, and what
follows. The weights of the model that drives it change step by step as it
runs. Learning is always on and there is no switch to stop it. Nothing is
pooled or uploaded: a ghost's weights are its own, trained only on compute
its owner has registered.

The owner is part of the ghost's world, not its teacher. The owner's
messages, steers, and ask answers are observations like tool output and file
state. There is no feedback button and no labelling step.

The base model stays frozen. Each ghost learns two things on top of it:

- **Critic.** Linear value and prediction heads over the base model's hidden
  states, learned with SwiftTD. It predicts the ghost's own future: its
  reward, and chosen signals in its stream.
- **Actor.** A per-ghost adapter on the top layers of the model that
  generates. It is updated online from the critic's TD error. This is what
  makes the ghost's weights its own.

## Contract changes (approved 2026-09-29)

The owner approved breaking whatever standing rules this path needs. Each
rule's text changes in the commit that breaks it:

1. **`docs/concepts.md`, "Local-first driver":** a learning loop built
   outside the core from `session_stop` hooks, and "no training journal",
   are both replaced by this design. The learner is core.
2. **`CONTRACTS.md`, "Product boundary":** the learner and the node protocol
   are new surface. The constraint no existing thing meets: *weights that
   change from the ghost's own experience, on compute the owner controls*.
   The deletions are in "Runtime simplification" below.
3. **Opt-in is gone.** Every ghost learns. So every ghost needs a compute
   node, and a ghost with no reachable node cannot take a turn. It fails
   with a typed error, the same way an unreachable provider fails today.
   Onboarding must register a node before the first conversation.
4. **Provider breadth is gone.** A ghost's model is its node. pi's
   multi-provider catalogue, logins, and model picker are cut (below).
   Frontier models stay reachable the way they already are: delegated from
   Bash (`claude -p`, `codex`).
5. **Privacy boundary:** from "this machine" to "compute nodes the owner has
   registered", which may be rented.

## Principles as applied

| Principle | How it shows up here |
|---|---|
| Own experience | Steps are cut from the ghost's own turns. Observations include everything that happens around them, the owner included. There is no dataset, no labels, and no judge model. |
| Batch size one, no replay | Each step updates the critic and the actor once, then is dropped. What survives a step is only what the algorithms define as state: traces, step sizes, and a bounded map of pending outcomes. |
| Learned credit assignment | Per-weight meta-learned step sizes everywhere. There is no global learning rate. |
| Tracking | No decay schedule. Step sizes rise and fall by meta-learning, and decay fires only while the overshoot bound is active. |
| Cheap per step | Fixed cost per step. The critic is O(d) on CPU. The actor is one backward pass through the adapted top layers for a bounded action length. Memory is fixed. |

## Experience stream

A **step** is `(t, φ, action, observations)`.

- **`φ`** is the node's hidden state for a window: the latest owner input,
  the tail of the current turn up to a token budget, a separator, and the
  action text. It is L2-normalised, and a bias feature is appended.
- **Steps** are cut at each owner input, tool call, final answer,
  edit-watch check, and delegate launch.
- **Observations** carried with a step:
  - tool results, including errors, malformed calls, and exit codes;
  - owner steers, aborts, branches, and reanswers;
  - ask answers, and whether the ghost's first option was chosen;
  - edit-watch results;
  - delegate outcomes;
  - elapsed time.

Which of these define reward is **TBD**, and so is the set of prediction
heads (see Open questions).

**Delayed consequences through TD.** Each ghost edit or write adds a
*watch*: the path, the SHA-256 of the written region, and the conversation.

- The check is by content, whether the region is still in the file. This
  catches `git checkout`, rewrites, and files outside any repository.
- Checks run at every later step and every 5 minutes while any watch exists.
- A watch expires after 2 h. At most 64 are held; the oldest is evicted.

A region that disappears is an observation in that conversation's stream.
Credit reaches the edit by TD bootstrapping and the actor's trace, never by
relabelling.

**Interleaved conversations.** Weights and step sizes are shared per ghost.
Per-stream state (SwiftTD's traces, and the actor's trace on the node) lives
in one of **K = 8 slots**. When a ninth conversation starts, the least
recently stepped slot is ended as a terminal step and reused. This caps
learner memory, not sessions.

## Critic

- **`value` head:** predicts the discounted return of the reward. SwiftTD,
  λ = 0.8. Its TD error is the actor's learning signal. It is the one head
  v1 cannot do without.
- **Prediction heads (GVFs):** each predicts one observation signal
  discounted over the ghost's future. For example, `steer` predicts owner
  steers over the next few turns, and `revert` predicts edit disappearance
  over the next half hour.
  - They are the Alberta Plan's "knowledge as prediction", about the ghost's
    own consequences.
  - They are cheap, and they show whether the features carry information
    before the actor depends on them.
  - Which ones ship is decided with the reward.

A per-call "will this tool succeed" head is dropped. Tool failures are mostly
model errors: an `edit` whose old text no longer matches the file, a
hallucinated path, bad arguments, or a command that exits non-zero. But a
separate predictor bought nothing the actor cannot learn directly. Tool
outcomes stay in the stream as observations.

### Algorithms

**IDBD** (Sutton 1992) is kept for any γ = 0 head, and as the base of the
actor's step-size family.

**SwiftTD** is a line-for-line port of the authors' dense reference,
`SwiftTDNonSparse::Step` in
[khurramjaved96/SwiftTD](https://github.com/khurramjaved96/SwiftTD) (MIT,
`36ec2de`). The port follows the reference where the brief's summary
differs:

- The meta update is normalised: `β_i += (θ/e^{β_i})(δ − v_δ)p_i`.
- The overshoot bound resets the `h` traces and `z̄`.
- Decay is `β_i += φ_i² ln ε`.
- The paper's `α_init = 1e-7` sits below `η_min = e^-15`, so the first step
  raises α to η_min. The port keeps this.
- One extension: γ may vary per step.

Defaults: `η = 0.1`, `ε = 0.99`, `θ = 1e-3`. θ is re-chosen by the stability
grid.

The critic lives in `packages/daemon/src/learn/`, in TypeScript with no new
npm dependency. It is fed by one tap where the daemon already fans out a
turn's events, plus the lifecycle calls (steer, branch, reanswer, ask
answer, abort).

## Actor

**Update: one-step actor-critic with eligibility traces** (Sutton & Barto
§13.5), batch size one. For conversation slot k:

1. **When the node generates action a_t:**
   - It computes `g_t = ∇_A log π(a_t|s_t)/|a_t|` over the adapter
     parameters A. This takes one backward pass through the adapted top
     layers, using activations it already holds.
   - It folds that into the slot's trace: `e_k ← γλ e_k + g_t`.
   - Nothing else about a_t is kept.
2. **When ghostd steps the `value` head:** it sends the TD error δ to the
   node, and the node applies `A ← A + α ⊙ δ e_k`.
   - α is per parameter and meta-learned, from the IDBD family
     ([arXiv 2401.17401](https://arxiv.org/pdf/2401.17401) is the
     reference).
   - SwiftTD's overshoot bound and decay carry over.
   - The variant is chosen by toy tests on the node.

Because the actor learns the policy itself, the hand-built critic uses from
earlier drafts are dropped:

- **Tool-call gate:** when to ask is an action the actor learns.
- **`ghost harnesses --for`:** which harness to delegate to is an action the
  actor learns.

This is Cursor Tab's lesson: learn show-or-don't in the policy instead of
filtering it afterwards.

### Why an adapter and not full weights

Full-weight updates are not ruled out. The costs, per ghost, for a model with
P parameters:

- **Memory:** per-parameter meta-learned step sizes need state beside every
  weight being learned: β, h, and one trace per slot. That is roughly
  (3 + K) extra copies, about 11× P, in float32.
  - For a large model that is terabytes even across six Studios, and it is
    per ghost, because each ghost has its own weights.
  - An adapter's state is megabytes to a few GB.
- **Compute per step:** full weights need a backward pass through every
  layer, across every Studio a sharded model spans, on every step. Top-layer
  adapters need one only through the layers on the last machine.
- **One base, many ghosts:** with adapters, every ghost of an owner shares
  one loaded base model. With full weights, each ghost is its own loaded
  model.
- **Stable features:** the critic reads the base model's hidden states. If
  the base weights move, its features drift under it. A frozen base keeps
  the critic's inputs fixed.
- **Ways back:** checkpoints, rollback, and export are small files.

**What an adapter gives up** is capacity. A low-rank change to the top
layers cannot rework what the lower layers compute.

**The middle ground** is full-rank training of just the top few layers, or a
higher LoRA rank. Adapter rank and depth are knobs chosen when the Studios'
real memory and step times are measured. The protocol carries adapter state
opaquely, so the choice can change later without a wire change.

## Compute nodes

A **node** is a machine that serves and trains a ghost's model. Examples: a
Mac Studio or several sharded together, a home NVIDIA box, or a rented cloud
GPU. ghostd stays on Omarchy, and the intelligence comes from the nodes.
ghostd reaches them over the tailnet or LAN, or over TLS for a rented node,
with a per-node bearer token.

**One protocol, several implementations**, following the relay pattern:

- `ghost-node` is a separate product in its own repository, with a
  `PROTOCOL.md`, a version handshake, and a conformance test here.
- The MLX implementation comes first, for the Studios.
- A PyTorch/vLLM node for NVIDIA and cloud GPUs follows on the same wire.

| Op | Purpose |
|---|---|
| `GET /ghost/v1/hello` | protocol version, base model id and weights hash, adapter shape, device summary |
| `POST /v1/chat/completions` | generation with the ghost's adapter. `X-Ghost-Learn: <ghost>/<slot>` makes the node accumulate that action's trace. |
| `POST /ghost/v1/features` | frozen-base hidden state for a text window |
| `POST /ghost/v1/step` | `{ghost, slot, delta, gamma_lambda}`: one actor update |
| `POST /ghost/v1/slot/end` | end a conversation's trace |
| `GET\|PUT /ghost/v1/adapter/:ghost` | pull or push adapter state for checkpoints |

- **Sharding** is the node's business. A model split across Studios is one
  node on the wire.
- **One base model** serves all of an owner's ghosts, each with its own
  adapter.
- **Base changes:** the state records `hello`'s weights hash. If the base
  changes, learning cannot continue on it, and status says so.
- **Trust:** each node is registered `owned` or `rented`. Rented cloud GPUs
  are first-class, because for many owners they are the only option.
  Registering one states that the provider can see what is in its memory.

## Runtime simplification

A ghost's model is now always its node, which speaks one OpenAI-compatible
dialect. Everything that exists to support many providers and models goes.
The candidates, to be confirmed file by file when this is built:

- **Provider logins:**
  - `ghost login`/`logout` and the `/login`, `/providers`, and account
    routes;
  - `login-command.ts` and `token-store.ts` (≈ 700 lines);
  - pi's `.pi/auth.json` flow.
- **Model choice:**
  - `ghost model` and `/model`, `GET /models`, and the HUD model picker;
  - `bindDefaultChatModelIfUnset` and the free-model onboarding path;
  - most of `models.json` provider policy (`models.ts`,
    `model-selection.ts`, `model-config-view.ts`, runtime
    `model-routing.ts`: ≈ 830 lines).
- **Model roles:** there is one model per ghost, and no separate small
  model. Titles, greetings, and `ghostd hook-complete` all call the
  ghost's own model on its node, with its adapter applied.
  - `smol_model` goes, along with the roles concept in `models.json`.
  - The cheapest-model ranking in daemon and runtime `smol.ts` goes
    (≈ 270 lines).
  - These calls send no learn header, so they are not learning steps: they
    sit outside any conversation's stream.
- **pi's provider catalogue:** the Anthropic, OpenAI, Google, AWS Bedrock,
  and other SDKs that pi-ai pulls in, tens of MB in `node_modules`.
  - What the daemon needs from pi is the agent loop, the session JSONL, the
    file, search, and Bash tools, steering and branching, and the extension
    events.
  - Whether pi's agent core takes a single OpenAI-compatible stream without
    pi-ai's provider set is checked in `node_modules` first. If it does not,
    the pi patch grows to cut the set.
- **`env-scrub.ts`:** its purpose was keeping ambient provider credentials
  out of pi. It is re-examined, not assumed deleted, because delegated
  harnesses rely on the scrubbed environment.

## Evaluation

There are no held-out turns and no frozen policy runs. What is reported:

- **Critic:** per head, lifetime MSE of the live head, of the weights frozen
  at first start (predict-nothing), and of a running mean of the target
  (base rate). Beating the base rate is the evidence that the features
  carry information.
- **Outcome rates over time:** kept daily for 90 days. They include edit
  persistence, owner steer rate per turn, tool failure rate, and asks
  answered with the ghost's first option (wasted asks), plus whatever the
  reward ends up being built from.
- **Actor:** adapter update size, the overshoot-bound activation rate, and
  step-size spread, so instability is visible.

**The trade, stated plainly:** without held-out turns there is no
counterfactual. A rate that improves over months may be the ghost learning,
or the owner's work changing. The critic's comparisons are the only
same-stream evidence.

`ghost learn status`, `GET /api/ghosts/:name/learn`, and a HUD row show the
same record, along with node health and skipped steps.

## Owner controls

| Verb | Route | Effect |
|---|---|---|
| `ghost learn status [--json]` | `GET …/learn` | the record above |
| `ghost learn rollback [<ckpt>]` | `POST …/learn/rollback` | restore an adapter checkpoint; learning continues from there |
| `ghost learn export <file>` | `GET …/learn/export` | critic state and latest adapter checkpoint |
| `ghost node add\|list\|remove` | `…/nodes` | register the compute a ghost runs on |

There is no `on`, `off`, or `feedback`. Rollback continues learning from an
earlier point rather than stopping it. It is the way back the
reversible-by-default invariant requires. Whether a full `reset` also exists
is an open question.

## State

```text
~/ghosts/<name>/learn/
  state.bin        header JSON (version, node id, base hash, dims, hyper-
                   parameters, counters, rate buckets) + Float32 blocks
  adapter/<date>/  last 7 daily adapter checkpoints, pulled from the node
```

- **Source of truth:** the ghost home. The node holds the working copy. A
  lost node costs at most a day of adapter steps, and a new node is seeded
  from the last checkpoint.
- **Critic writes:** every 50 steps and on stop, through the control-file
  writer (temp, fsync, rename, fsync dir). A corrupt file is set aside and
  reported.
- **Lifecycle:** the directory moves with the home on rename and goes to
  Trash on delete. It gets one row in the state-survival table.
- **No event log.** Debugging reads status and the journal.

## Privacy

The learner and the model client talk only to registered nodes, and learner
files are 0600 in the ghost home. Tests:

- network APIs are spied during a synthetic stream, and every destination
  other than the registered node must be unused;
- an import scan of `src/learn/`;
- an unregistered origin is refused, and a rented origin is accepted only
  over TLS.

## Tests

- **IDBD noisy stream** (Oak Lab setup):
  - 4,096 Bernoulli(0.01) features;
  - target = feature 0, plus ±1 with p = 0.01, plus Gaussian noise with
    variance 5;
  - IDBD reaches `|w₀ − 1| < 0.1` and mean `|w_noise| < 0.02`;
  - SGD at its best α shows at least 5× IDBD's noise weight;
  - step sizes and step count are fixed from a committed sweep.
- **SwiftTD matches the reference:** a fixture from
  `scripts/swifttd-golden.py` (`uv run --with SwiftTD`, outside the gate),
  matched within 1e-4 relative error.
- **SwiftTD stability:** a grid of α_init ∈ {1e-7 … 1e-1} × θ ∈ {1e-4 …
  1e-1}, with constant and per-step γ. Every run stays finite, with error at
  most 10× the zero predictor.
- **Fixed cost:** state size is identical after 10³ and 10⁵ steps, step
  time is flat, and heap growth is bounded. Slot eviction is covered.
- **Actor on the node:** a contextual bandit and a delayed-reward chain on a
  tiny model. The adapter learns the rewarded action, stays stable over a
  grid, and has flat per-step cost.
- **Node conformance, crash safety, wiring, privacy.** Wiring includes a
  turn failing cleanly when the node is unreachable.

## Build order (after the Studios arrive)

1. `idbd.ts`, `swift-td.ts`, and their tests.
2. `PROTOCOL.md`, a stub node, and the conformance test. Check how much of
   pi survives with a single OpenAI-compatible stream.
3. `ghost-node` on MLX: generation, features, and adapter state. Measure
   step time and memory, then choose the base model, adapter rank, and
   depth.
4. Runtime simplification: the node becomes the only model path, and
   logins, the picker, and the provider catalogue are deleted.
5. Critic in ghostd: tap, watches, slots, state, status, and the contract
   and survival rows.
6. Actor: toy tests on the node, then real turns, checkpoints, and rollback.
7. HUD row and onboarding (register a node first).

## Open questions

1. **Reward:** TBD. What in the ghost's own stream counts as reward, and
   which prediction heads ship alongside `value`.
2. **Reset:** keep a full `reset` (to Trash) beside `rollback`, or is
   rollback the only way back?
3. **Adapter size:** rank and depth, or full-rank top layers, decided from
   Studio measurements.
