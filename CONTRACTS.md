# Contracts

Stable boundaries shared by Ghost's packages and clients. Change these in one
commit with every consumer. Implementation detail belongs in code and tests.

## Product boundary

Ghost is an owner-local Omarchy application: one owner, one machine, any number
of ghosts. `ghostd` owns sessions and state transitions; the Quickshell HUD,
terminal client, Chromium relay, and desktop helper are clients or sidecars.
The daemon listens on loopback unless the owner explicitly enables the built-in
Tailscale Serve viewer.

Durable state has three scopes:

- **Ghost-private:** character, memory, conversations, settings, and runtime
  sidecars live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, plans, and tasks live in an
  Obsidian vault selected by Obsidian. Every ghost accesses it exclusively with
  the official Obsidian CLI and the upstream `obsidian-cli` machine skill.
- **External:** trusted projects, browser downloads, screenshots, systemd user
  timers, and Secret Service credentials stay in the machine facility that owns
  them.

Ghost never infers an Obsidian vault path, scans for `.obsidian`, assumes
`~/Documents`, or reads/writes vault files directly. The CLI's current vault is
the default; `vault=<name>` selects an owner-named vault. Obsidian state is
unaffected by creating, renaming, deleting, or uninstalling a ghost.
Ghost does not use the separate Obsidian Headless client: owner-shared note and
task operations require the desktop-linked CLI and therefore a graphical
Obsidian instance.

There is no Ghost plan mode, todo store, plan/todo API, or progress UI. Runtime
native planning may exist, but durable owner-visible plans and tasks belong in
Obsidian. Background jobs remain Ghost runtime state because they control work
currently executing in a conversation.

## Ghost home (`ghost-home/v2`)

The default root is `~/ghosts`; each direct child is one ghost:

```text
~/ghosts/<name>/
  character.md
  memory/*.md
  skills/<name>/SKILL.md
  agents/<name>.md
  commands/<name>.md
  rules/  prompts/  hooks/
  AGENTS.md  CLAUDE.md  WATCHDOG.md  LINT.yml
  settings.yml
  models.json
  mcp.json
  sessions/
  .tasks/
  .pi/
  .memory-maintenance.json
```

The directory is the atomic lifecycle unit. Rename and deletion hold a
filesystem-identity lease and move the whole home on the same filesystem.
Deletion goes to freedesktop Trash, with a recoverable `.trash/` fallback for
`EXDEV`; Ghost never recursively removes a home. Machine credentials, Obsidian,
trusted projects, screenshots, downloads, and timers are not moved with it.
The lifecycle implementation and crash recovery are in
[`home-operations.ts`](packages/daemon/src/home-operations.ts),
[`home-reservation.ts`](packages/daemon/src/home-reservation.ts), and
[`session-host.ts`](packages/daemon/src/session-host.ts).

`settings.yml` may name the ghost's own git clone of this repository, as a
`self:` mapping with a `checkout:` value that is an absolute path under the
owner home; any other value reads as unset. It feeds the self-maintenance
policy only. It is never auto-bound: the owner trusts and binds that checkout
through the same explicit project boundary as any other project.

### Character and memory

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body (maximum 20,000
JavaScript UTF-16 code units) is the persona. A seeded or blank character marks onboarding; the ghost
shows the owner a draft and waits for confirmation before replacing it.

`memory/*.md` is this ghost's private internal continuity: subjective
reflections, ghost-specific interpretations, and commitments about its own
behavior. It is not the owner's knowledge store. Owner facts and preferences,
shared decisions, project knowledge, notes, plans, and tasks go to Obsidian.
The owner can inspect memory for transparency; other ghosts do not consume it.

Each memory is one Markdown file named by a lowercase kebab-case slug. Content
is limited to 2,000 UTF-16 code units and 6,001 bytes. The session-start index
lists at most 4,000 characters of complete slugs, newest modification first.
Unsafe, linked, invalid-UTF-8, or oversized entries are skipped; direct reads
fail rather than truncate. API writes redact common credential forms before
disk. Exact parsing, descriptor confinement, redaction, and limits are defined
in [`memory-file.ts`](packages/extensions/src/memory-file.ts),
[`home.ts`](packages/extensions/src/home.ts), and their tests.

Native runtime file tools can write character and memory directly. They do not
receive the API writer's validation/redaction guarantees; the system prompt
states the hard limits and the next cold session rejects or omits invalid data.

### Declarative resources and projects

Visible ghost-home instructions, skills, rules, Markdown commands/prompts, MCP,
and trusted `hooks/pre` and `hooks/post` factories form an immutable session
snapshot. Hidden compatibility roots inside a ghost home are not aliases.
Machine skills under `~/.agents/skills/` and `~/.pi/agent/skills/` enter at
lowest precedence, then ghost resources, then one explicitly trusted project.
There is no skill-name allowlist.

Project instructions, skills, rules, commands/prompts, and MCP are data-only.
Project plugins, executable hooks/tools, LSP, and custom subagents stay disabled
until they have a per-session isolation boundary. `agents/*.md` is preview-only
for Pi; Claude Code retains its native subagents. Project trust is bound to the
canonical filesystem identity, not a path string. The scanner and persisted
snapshot shapes are in
[`declarative-snapshot.ts`](packages/daemon/src/declarative-snapshot.ts),
[`project-binding.ts`](packages/daemon/src/project-binding.ts), and
[`project-snapshot.ts`](packages/daemon/src/project-snapshot.ts).

### Sessions and sidecars

Conversation public ids are runtime-qualified (`pi:<raw>` or
`claude-code:<raw>`). Raw ids remain the runtime resume identity. Pi transcripts
are JSONL under `sessions/`; Claude transcripts remain in Claude Code's own
storage and Ghost keeps only its resume metadata. Pins, read timestamps,
project bindings/snapshots, tool-call cwd records, idle-maintenance journals,
and crash markers are bounded sidecars under `sessions/`.

Each Claude conversation also gets a bounded presentation-journal sidecar
(`*.claude-code.presentation.json`): one owner prompt plus final assistant text
per settled turn, so the HUD can render the conversation. It is display state,
never runtime resume state — a journal alone never publishes a conversation id,
a journal-write failure only logs and marks the missed prefix unavailable on
the next write, and the sidecar moves to Trash with its conversation. Pi
conversations write no journal; their JSONL is already the durable history.
See [`presentation-history.ts`](packages/daemon/src/presentation-history.ts).

Opting in with `review.journal: true` adds a second bounded sidecar on both
runtimes (`*.<runtime>.review-journal.json`): one entry per reviewed turn
holding the turn delta, the lint findings and advisor notes it drew, where they
were delivered, and the rewrite a strict continuation produced. It is written
only while `review.mode` is not `off`, every text field is secret-redacted and
capped before disk, oldest entries are dropped at its bounds, a write failure
only warns, and it moves to Trash with its conversation. Like the presentation
journal it is display and training state, never runtime state; nothing reads it
back at runtime. See
[`review-journal.ts`](packages/daemon/src/review-journal.ts).

Forking copies a Pi conversation before one persisted user entry; it never
rewinds the source. Deletion moves every Ghost-owned artifact for that public id
to recoverable Trash. Fork and delete use durable markers so an unpublished or
partially moved artifact stays hidden until recovery completes. The file naming,
allowlists, and recovery state machines live beside their focused tests in
[`session-host.ts`](packages/daemon/src/session-host.ts) and
[`session-files.ts`](packages/daemon/src/session-files.ts).

### Machine-owned artifacts

- Screenshots use the Omarchy/XDG Pictures directory and exact
  `ghost-<ghost>-{screen|browser}-<timestamp>.png` names. Retention touches only
  those names.
- Downloads are owned by the owner's Chromium configuration.
- Scheduled work is a systemd user `.timer`/`.service` pair named
  `ghost-timer-v1-<name-length>-<ghost>-<slug>`. Ghost prompts author persistent
  units; rename/delete retire units owned by that prefix. See
  [`schedules.ts`](packages/daemon/src/schedules.ts).
- Provider and MCP credential values live in Linux Secret Service. `models.json`
  and `mcp.json` hold service/account references only. See
  [`docs/keyring.md`](docs/keyring.md).
- Finished artifacts go to the destination the owner requested. Ghost has no
  default Documents destination or automatic document index.
- Delegated coding work has one private `task-record/v2` JSON record under the
  ghost home's mode-0700 `.tasks/` directory. Records move to Trash with their
  parent conversation and are not portable runtime configuration.

### State survival

What each kind of state does under the events that move it. "The home" is the
ghost home directory, which moves as one unit.

| State | Daemon restart | Ghost rename | Ghost delete | Rebuild + restart | Snapper rollback of `/` | Package reinstall |
| --- | --- | --- | --- | --- | --- | --- |
| `character.md`, `memory/*.md` | survives | moves with the home; the character seed is rewritten to the new name | to Trash with the home | unchanged | unchanged | preserved |
| Conversations and sidecars under `sessions/` | survives; Pi JSONL is the durable history | moves with the home; Claude transcripts stay in Claude Code's own storage, only resume metadata moves | to Trash with the home | unchanged | unchanged | preserved |
| `.tasks/` records | survive; a non-terminal record becomes `interrupted` with `daemon_restarted` after its scope is quiesced | moves with the home | to Trash with the home | as a restart | unchanged | preserved |
| `.pi/` derived state | survives | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| `settings.yml`, `models.json`, `mcp.json` | survives | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| Project trust ledger (`$XDG_STATE_HOME/ghost/project-trust.json`) | survives | untouched; the ledger is owner-wide and identity-bound, never ghost-scoped | untouched | unchanged | unchanged | preserved |
| Keyring credentials | survive | never touched | never touched | unchanged | unchanged; the store is `~/.local/share/keyrings` | preserved |
| Timers `ghost-timer-v1-*` | unaffected; systemd owns them | stopped and removed before the rename completes | stopped and removed before the delete completes | unchanged | persistent units unchanged; `$XDG_RUNTIME_DIR` units are tmpfs | preserved |
| Screenshots in the XDG Pictures directory | survive | not moved; filenames keep the old ghost name | not removed | unchanged | unchanged | preserved |
| Presentation-journal sidecars | survive | move with the home | to Trash with their conversation | unchanged | unchanged | preserved |
| Review-journal sidecars (opt-in) | survive | move with the home | to Trash with their conversation | unchanged | unchanged | preserved |
| The ghost's `self.checkout` clone | untouched | untouched | untouched | it is the source | unchanged | unchanged |
| The running build | re-execs the same build | unchanged | unchanged | replaced | a packaged install under `/usr` rolls back; a build from a clone under the home does not | replaced |

The rollback column assumes Omarchy's btrfs layout, where `/` is the `@`
subvolume and `/home` is `@home` with no snapper config of its own. Confirm it
before relying on the column:

```sh
findmnt -no SOURCE / /home
ls /etc/snapper/configs
```

Where `/home` is a separate subvolume that snapper does not cover, a rollback of
`/` restores the packaged install and system configuration and leaves every
ghost home, the trust ledger, the keyring store, the persistent timer units, and
the ghost's own checkout exactly as they were. Nothing in this table is a
backup: Trash and snapper are undo, not retention.

## Runtime contract

Both runtimes receive the same Ghost character, private memory index, first
meeting policy, Omarchy computer-use policy, scheduled-work policy,
self-maintenance policy, shared
Obsidian policy, and—when native worker services are configured—delegation
policy and tools. Normal machine-skill discovery admits the owner-installed
`obsidian-cli` skill into each runtime's standard skill index; the shared-state
policy does not duplicate its path or contents. Obsidian content is fetched
only when relevant through `obsidian`, never injected automatically at session
start.

The operational cwd defaults to the owner home and may be rebound to one
trusted project. Ghost home remains a separately named private resource root.
Prompt indexes are session-start snapshots; current data is read through the
owning tool when needed.

### Pi

Pi sessions use `createAgentSession`, an explicit transcript, Ghost's model
runtime and credential store, an in-memory settings manager, and an explicit
resource snapshot. Pi's inherited system prompt, ambient context/config/MCP,
automatic credential discovery, themes, prompt templates, executable project
code, and native task tool do not enter the session. Ghost keeps Pi's native
file, search, Bash, compaction, steering/follow-up, and branch behavior —
supplying its own summary instructions and pinning Pi's raw retained-tail
target to 500 tokens (Pi may keep more to respect message and tool-call
boundaries; Claude Code's native compaction is unaffected) — and
adds `ask`, supervised native-worker delegation, background jobs, browser,
screen, desktop, and MCP tools. `inspect_image` is added only when the active
chat model does not accept image input; vision-capable Pi models use their
native image understanding. The exact assembly is
[`SessionHost.create`](packages/daemon/src/session-host.ts) and the seam is
[`pi-extension-bridge.ts`](packages/daemon/src/pi-extension-bridge.ts).

### Claude Code

`claude-code/default` uses the official Claude Agent SDK with the owner's
installed, unmodified `claude` executable and native authentication. Ghost
accepts any method for which `claude auth status --json` says `loggedIn: true`;
it never receives or stores the credential. The SDK is loaded only from Ghost's
versioned XDG data root with exact package/version/entry validation. Detailed
installation and environment guarantees are in
[`docs/claude-code-runtime.md`](docs/claude-code-runtime.md).

Claude keeps its native preset, including `AskUserQuestion`, image
understanding, subagents, background tasks, todos, web tools, and planning.
Ghost routes `AskUserQuestion` through the same daemon broker and HUD as Pi's
`ask` without denying or replacing any native tool. Claude's complete native
tool preset remains available; Ghost's browser/screen/desktop and supervised
delegation tools are additive. Ghost disables Claude auto-memory; shared
persistence is Obsidian and private continuity is Ghost memory.

The Claude Code path is native-first. A capability already supplied by the
native `claude_code` preset keeps Claude's tool name, schema, result, and
semantics; Ghost integrates its callbacks and events with daemon/HUD surfaces
instead of registering a substitute. Additive Ghost tools are limited to
Ghost-specific capabilities the preset does not supply, and must not shadow a
native tool. This rule follows the harness Claude models are trained to use and
lets new native tools arrive with the installed compatible Claude Code version
without a Ghost allowlist change.

Ghost-owned model capabilities have one cross-runtime contract even when the
runtime supplies the implementation: owner questions, image understanding,
browser/screen/desktop control, and supervised delegation are available on
both principal paths. Runtime mechanics remain native. Pi exposes its
transcript, branches, commands, steering, and `GhostJob` state through daemon
APIs; Claude serves a thin settled-turn presentation transcript and otherwise
owns the corresponding session and background-task state inside its opaque
warm query.

Two deliberate capability gaps remain. Pi's MCP manager admits ghost-home MCP
plus trusted-project MCP, including secret resolution and per-server cwd;
Claude currently admits only credential-free trusted-project MCP that its SDK
can represent and persist. Trusted ghost-home `hooks/pre` and `hooks/post`
extension factories are Pi-native executable extensions and do not enter
Claude. These exceptions must stay visible in the resource/API surfaces and
must not be presented as shared capabilities.

### Ask, jobs, delegation, hooks, and maintenance

`ask` is owner input, never tool approval. Pi's model-facing `ask` input and
output match Claude Code's native `AskUserQuestion` contract: one to four
questions, two to four described options per question, `multiSelect`, optional
previews and metadata, answers keyed by question text, and optional per-question
annotations. The internal wire name remains `ask` for both runtimes so the HUD
has one predictable interaction. A pending question is pollable and the first
valid response wins. The daemon-wide timeout defaults to 120 seconds; zero
waits forever. A model-facing timeout returns an empty answer map and never
invents an owner selection.

In Pi, every Bash command is represented by a `GhostJob`. Foreground commands
wait for the configured budget, then continue as background jobs. Job
completion is fed back into the same conversation; closing the session cancels
running jobs. Jobs are process-local and an unopened conversation reports
`[]`. Claude keeps its native Bash and background tasks; they do not appear in
the `GhostJob` API.

Delegated coding tasks are conversation-scoped work executed by an installed
Pi, Codex, or Claude Code harness. Starting one requires a current trusted
project binding; arbitrary cwd is never authority. Ghost durably records its
bounded assignment, lifecycle, events, result, exact project-binding receipt,
and private process-ownership receipt. Tasks have no Ghost concurrency limit.
Running work accepts follow-up or cancellation; cancellation, shutdown, and
startup recovery do not publish a terminal state until the exact captured
systemd user scope is confirmed quiescent. A restart interrupts rather than
resumes prior work. The lifecycle is implemented by
[`tasks.ts`](packages/daemon/src/tasks.ts), the three native adapters, and
[`native-task-scope.ts`](packages/daemon/src/native-task-scope.ts).

The principal delegation policy names when to escalate: the ghost drives its
own turn and hands a specialist only work it cannot finish reliably, and the
review journal records how many times each reviewed turn escalated.

The installed harness owns its native project discovery, skills, agents, MCP,
tools, model/auth behavior, and session semantics. Ghost owns only admission,
bounded protocol projection, durable lifecycle, and exact process-tree cleanup;
it never invents a Git worktree, branch, commit, or approval flow for a task.

Awaited harness hooks are `before_prompt`, `session_stop`, and
`conversation_idle`. Their JSON protocol, failure behavior, and settings are
defined in [`docs/hooks.md`](docs/hooks.md). Built-in idle maintenance may write
or consolidate only private memory; shared knowledge and task maintenance uses
Obsidian during ordinary runtime work.

One built-in review pipeline runs at `session_stop` on both runtimes. Per ghost,
`settings.yml` selects `review.mode` (`off` default, `lint`, `advisory`, or
`strict`), non-negative `review.immuneTurns` (default 3), and the opt-in
`review.journal` boolean (default off) that records each reviewed turn to the
conversation's review-journal sidecar. Its deterministic
producer lints final-assistant prose outside fenced code plus command and path
strings recovered from current-turn tool-call arguments. Built-in rules emit
only `nit` and `concern`; owner and trusted-project `LINT.yml` rules may also
emit `blocker`. They augment the built-in pack and, only for an
identity-validated project binding, ancestor `.ghost/LINT.yml`, `.omp/LINT.yml`,
and `LINT.yml` files discovered in the same order as `WATCHDOG.md`; a file may
disable built-in rule ids. Transcript
fallback still lints prose and skips command/path targets.
The model producer runs only in `advisory` and `strict`, uses `advisor_model`,
and judges the bounded, secret-redacted current turn against ghost-home and
trusted-project `WATCHDOG.md` policy. Lint findings enter delivery on their own
deterministic authority and the model is told which rule ids were already
delivered; it never re-judges them. Review-policy discovery is ghost home first,
then trusted project root to leaf. At every project level Ghost probes
`.ghost/<FILE>`, `.omp/<FILE>`, then `<FILE>`; `.omp/` preserves oh-my-pi
compatibility. Ghost's `WATCHDOG.md` format and `nit`, `concern`, and `blocker`
severities match OMP's, so an existing OMP policy works as-is. OMP's
`WATCHDOG.yml` advisor roster is not read yet.

Both producers feed the same severity, emission-guard, note-ledger, channel,
and consume-once feedback path. `lint` and `advisory` always send accepted
`nit`, `concern`, and `blocker` notes through the next-turn `before_prompt`
bridge. In `strict`, `nit`/`concern` use that bridge; a blocker with cooldown
clear may request exactly one continuation when `stop_hook_active` is false,
while cooldown and continuation-pass blockers become next-turn feedback. A
strict continuation starts the `review.immuneTurns` cooldown. The feedback,
cooldown, dedupe, and ledger state are bounded and non-durable, so restart drops
rather than replays them. Transcript, model, parse, discovery, and quarantine
failures fail open; a model failure never discards lint notes. Built-in hook
settings keys are only `memory_upkeep` and `review`.

## Daemon HTTP API

`ghostd` is the only session owner. All `/api/*` routes require the bearer token
from Ghost's mode-0600 XDG-state token file, except `GET /api/relay/status`
(deliberately open relay liveness; it carries no secret), explicitly public
viewer assets, and authenticated tailnet requests. Loopback CORS allows only the exact
HUD/client methods and headers. Errors are
`{ "error": { "code": string, "message": string } }` with a meaningful HTTP
status. Request bodies and control files are bounded before allocation.

Tailnet identity is accepted only from Tailscale Serve's verified local proxy
boundary. The configured owner has full access; admitted guests are read-only.
Remote access never broadens a ghost's local tool authority.

Route parsing, validation, status codes, and reverse states are executable in
[`server.ts`](packages/daemon/src/server.ts) and
[`server.test.ts`](packages/daemon/test/server.test.ts). Stable route families:

Rows beginning `/sessions/` or `/login/` are relative to `/api/ghosts/:name`.

| Route | Contract |
|---|---|
| `GET /api/hooks` | Redacted hook status. |
| `GET /api/relay/status` | Unauthenticated relay liveness; carries no secret. |
| `GET\|PUT /api/hooks/config` | Read or atomically replace the admitted `hooks.json`. |
| `GET /api/harnesses` | Bounded availability/authentication for native Pi, Codex, and Claude Code workers. |
| `GET /api/status` | Owner-only `{ version, source: { commit, root } }`. `root` is the git root of the running entry script, or `null` for the packaged install; a guest is refused the row rather than shown a filesystem path. |
| `GET\|POST /api/ghosts` | List or create ghosts. |
| `PUT /api/ghosts/:name/name` | Rename a ghost and its whole home. |
| `DELETE /api/ghosts/:name?confirm=:name` | Move a ghost home to recoverable Trash. |
| `GET\|PUT\|DELETE /api/ghosts/:name/memory` | List, write, or trash private memory. |
| `GET\|PUT /api/ghosts/:name/character` | Read or atomically replace the persona file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `GET\|PUT /api/ghosts/:name/model` | Read or set the chat model. |
| `GET /api/ghosts/:name/models` | Paginated available/catalog model rows, detected local endpoints included in both scopes; `q` is at most 256 characters. |
| `GET\|PUT /api/ghosts/:name/model-routing` | Read or replace role primaries/fallbacks. |
| `GET /api/ghosts/:name/providers` | Login-capable Pi providers and accounts. |
| `POST /api/ghosts/:name/login` and `GET\|POST /login/:id[/input]` | Start, poll, and answer a provider login. |
| `DELETE /api/ghosts/:name/providers/:provider/accounts/:account` | Remove one Ghost-owned Secret Service account item. |
| `GET\|POST\|PUT\|DELETE /api/ghosts/:name/mcp…` | Sanitized MCP catalog, mutation, enablement, reconnect, and isolated test. |
| `POST /api/ghosts/:name/greeting` | `{ greeting: string|null, onboarding }`; generation failure is a null greeting, not a 5xx. |
| `POST /api/ghosts/:name/messages` | One turn as the pi-messages SSE protocol. |
| `GET /api/ghosts/:name/events` | Conversation invalidation SSE; clients refetch affected state. |
| `GET /api/ghosts/:name/sessions` | Runtime-qualified conversation summaries. |
| `GET\|PUT\|DELETE /sessions/:id/project…` | Read, preview, bind/reload/unbind, or abandon an unpublished trusted-project draft. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `GET /sessions/:id/commands` | Effective Pi slash-command catalog; Claude returns not supported. |
| `GET /sessions/:id/resources` | Owner-only immutable skill/MCP admission snapshot, including source, precedence, shadowing, skips, and standard Obsidian-skill readiness. Pi may open an idle snapshot for inspection; Claude reports only a live warm query and otherwise returns 409. |
| `POST /sessions/:id/recap` | Non-persisted bounded Pi recap; failure returns `recap:null`. |
| `GET /sessions/:id/jobs` | `{ jobs }` for the open conversation. |
| `POST /sessions/:id/jobs/:jobId/cancel` | `{ outcome, job }`; unknown is 404. |
| `GET /sessions/:id/transcript` | Paged renderable history. Pi projects its own JSONL; Claude serves the settled-turn presentation journal. `historyTruncated` marks an unavailable prefix; a message's optional `contentTruncated: true` marks bounded stored text. |
| `GET\|POST /sessions/:id/ask` | Inspect or resolve one pending owner question. |
| `GET\|POST /sessions/:id/queue` | Inspect/enqueue Pi steering or follow-up text. |
| `GET\|POST /sessions/:id/tasks` | List bounded task projections or start one trusted-project native worker. |
| `GET /sessions/:id/tasks/:taskId` | Read one owned task with bounded events/result. |
| `POST /sessions/:id/tasks/:taskId/{send,cancel}` | Follow up on running work or request confirmed cancellation. |
| `POST /sessions/:id/branch` | Fork before one persisted Pi user entry. |
| `POST /sessions/:id/reanswer` | Reopen an historical ask result and resume that branch. |
| `DELETE /sessions/:id` | Move every Ghost-owned conversation artifact to Trash. |
| `GET\|POST /sessions/:id/live` | Reserved voice boundary; default is not supported. |
| `GET\|POST /sessions/:id/collab` | Legacy injected-host boundary; Ghost ships no host. |
| `GET /api/remote/whoami` | Effective owner/guest identity. |
| `GET\|POST /api/remote` and `GET /api/remote/qr.svg` | Tailscale Serve status/control and active URL QR. |
| `GET /manifest.webmanifest` | Public viewer manifest. |

There are intentionally no `/plan` or `/todo` session routes.

### pi-messages wire

The event union is the contract; clients must ignore unknown future event
types. See [`pi-messages.ts`](packages/daemon/src/pi-messages.ts) and its
conformance tests. A turn emits `start`, ordered text/thinking/tool/command/
queue/branch events, and exactly one terminal `done` or `error`. Tool execution
events include the call id, tool name, captured cwd, and safe summary; private
reasoning is never restored through the transcript API. A standalone slash
command emits `start`, `command_output`, then zero-usage `done` and is not
persisted as an assistant answer.

### `ghost` CLI

The terminal client is an HTTP client only; it never edits a ghost home
directly. Its command catalog is defined in
[`cli/main.ts`](packages/daemon/src/cli/main.ts). It supports conversation,
ask, job, model, memory, status, and skill operations. `ghost model login`,
`ghost model logout`, and `ghost model --providers` are thin clients of the
`/login`, `/providers`, and account routes above: the daemon owns the whole
flow and the CLI holds no secret, only rendering each polled `LoginView` and
posting the answer the owner types. `ghost delegation` is the one daemon-free
read-only command: it probes installed native-worker harnesses without opening
ghost data. There are no plan or todo commands.

## Models and credentials

`models.json` owns provider policy, exact Secret Service account references,
roles, and retry chains. Credential values never enter that file, logs, API
responses, or ghost-home backups. Inherited provider/auth environment variables
are scrubbed before Pi runtime construction. Claude Code receives a separate
reviewed operational/selector environment captured before the global scrub; its
credential-bearing values are excluded. The implementation allowlists and tests
in [`env-scrub.ts`](packages/daemon/src/env-scrub.ts) and
[`claude-code.ts`](packages/daemon/src/claude-code.ts) are normative.

Roles are `chat_model`, `smol_model`, `slow_model`, `vision_model`,
`plan_model`, `designer_model`, `commit_model`, `tiny_model`, `task_model`, and
`advisor_model`. Each may have an ordered fallback chain where the runtime
supports it. `claude-code/default` is valid only as the primary chat runtime;
it is not a Pi provider model and is never a role fallback.

`chat_model` uses an explicit usable selection or Pi's catalog default.
`smol_model` serves titles, greetings, and trusted command-hook completions. If
unset, it chooses the cheapest usable model, treating an authenticated
subscription as zero marginal cost. An explicit unusable smol binding fails
loudly rather than silently switching models. Conversation titles are one
persisted Pi `session_info` name after the first turn; owner titles win.

Local OpenAI-compatible endpoints are detected, not configured. Every Pi
runtime construction probes `127.0.0.1` on the well-known runner ports —
`local-ollama` 11434, `local-lm-studio` 1234, `local-llama-cpp` 8080,
`local-vllm` 8000 — in parallel with a short timeout, and publishes each
answering endpoint as a zero-cost provider of every model id it lists. A
refused connection, a timeout, a non-JSON body, or an empty list is silence,
not an error. Detected providers are runtime facts: they appear in both
`scope=available` and `scope=catalog` rows and a switcher pick persists like
any other, but detection itself never writes `models.json`. With no
`chat_model` binding and no configured provider, the first model of the first
detected endpoint drives the ghost, in the runner order above, and the
current-model response marks it `source: "default"` with `origin: "local"`.
Any explicit binding or configured provider wins, a ghost whose principal
runtime is Claude Code keeps its own model and is unaffected, and `offline`
skips the probe in every daemon-owned runtime.

Ghosts run unthrottled. Provider, runtime, and context limits surface as typed
errors and use configured runtime retry/fallback behavior; Ghost adds no turn,
hosted-session, concurrency, or spend cap.

## Package boundaries

- [`packages/extensions`](packages/extensions/src/index.ts) is runtime-neutral:
  ghost-home parsing, prompt construction, pure tools, browser/desktop clients,
  and the `extension-api.ts` seam. It imports no daemon or UI.
- [`packages/daemon`](packages/daemon/src/main.ts) owns configuration,
  authentication, sessions, runtime adapters, models, MCP, hooks, lifecycle,
  jobs, delegated-task admission and process ownership, HTTP, and the `ghost`
  CLI. Bun is the production runtime.
- [`packages/shell`](packages/shell/qml/shell.qml) is a Quickshell client. It
  talks only to authenticated HTTP/SSE and never edits daemon-validated ghost
  state (memory, character, control files) directly; the one deliberate
  exception is the workbench file editor, which writes ordinary files at the
  owner's explicit direction.
- [`packages/chromium-extension`](packages/chromium-extension/extension) is the
  opt-in MV3 relay into the owner's Chromium. Pairing and workspace ownership
  are capability-scoped; there is no second browser backend. Client text
  frames are capped at 32 MiB of UTF-8 before JSON parsing.
- [`packages/desktop-helper`](packages/desktop-helper/src/ghost_desktop_helper)
  is the Python JSON-lines computer-use sidecar. Root pnpm commands do not cover
  it. Its startup handshake and the extensions client agree on desktop-helper
  protocol version 2; a mismatch retires the sidecar before any request is sent.
  Startup/explicit `hello` is the diagnostic boundary; there is no `doctor` op.
  Client errors retain the operation: unavailable transport is `not_found`,
  deadlines/size are `limit_exceeded`, and malformed protocol is `invalid_format`.
- [`packaging`](packaging) owns package assembly, smoke tests, and release
  candidates, not user data or service activation policy.

Protocols implemented by a sidecar have one detailed document:
[`docs/hooks.md`](docs/hooks.md),
[`docs/claude-code-runtime.md`](docs/claude-code-runtime.md), and
[`docs/desktop-helper.md`](docs/desktop-helper.md). Release publication's
fail-closed state machine lives in
[`docs/release-publication.md`](docs/release-publication.md).

## Harness and lifecycle invariants

- Never start a test daemon against `~/ghosts`, the live port 7717, or the live
  Quickshell bus. Tests use scratch homes and the shell preview's private
  HOME/XDG/dbus/Hyprland.
- One daemon process owns a session. A conversation rejects conflicting owners;
  queued Pi steering/follow-ups are the explicit exception.
- Home rename/delete, project transitions, MCP mutation, model refresh, live
  voice, collaboration, maintenance, fork, and conversation deletion use
  explicit leases and publish only durable state.
- Control files are bounded, validated, atomically replaced, and fail closed on
  links, malformed bytes, identity changes, ambiguous recovery, or incomplete
  fsync.
- Browser/session/process teardown tracks exact captured owners and PIDs. No
  cleanup may kill by pattern or remove a broad directory.
- Native delegated work runs in an exact receipt-bound
  `ghost-task-<UUID>.scope` under the user manager. Ghost requires
  `systemd>=254`, never adopts a pre-existing unit, and reaches a terminal
  cancellation/interruption state only after the whole captured scope is
  authoritatively inactive or absent.
- Logs redact secrets and private payloads. Journal identity fields are `GHOST`
  and `CONVERSATION`; other structured fields remain in `MESSAGE`.
- Package install/upgrade must not enable Ghost until the desktop owner has the
  official Obsidian CLI registered, `obsidian version` succeeds with the app
  open, and the upstream skill exists at
  `~/.agents/skills/obsidian-cli/SKILL.md`. Root ALPM hooks may only report this
  requirement; issue #54 owns the supported user-level readiness gate.
- Package removal preserves ghost homes, XDG config/state, Secret Service
  items, the Obsidian skill, and all vaults.
- Reversible by default. Disable before delete, Trash instead of `rm`,
  checkpoint before rewrite. Every destructive move has a named way back and a
  way to see it; an audit record of an unrecoverable action is not a substitute
  for undo.
- Self-restart is a systemd handoff. The daemon never restarts itself in
  process, and there is no guardian process and no rebuild-and-restart tool. A
  ghost restarts ghostd by scheduling `systemctl --user restart ghostd.service`
  in a transient `systemd-run --user` unit whose `--description` carries the
  reason, and the same reason is in the commit. That is the principal acting
  through its own Bash, so the delegated-task rule against inventing a Git
  worktree, branch, or commit does not apply to it. See
  [`docs/self-maintenance.md`](docs/self-maintenance.md).

Focused tests beside the implementation are part of these contracts. GitHub
issues track unfinished work and release evidence; this file describes the
desired end state, not the backlog.
