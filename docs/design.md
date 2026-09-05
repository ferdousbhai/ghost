# Ghost — design

Ghost is a local AI persona for one owner: character, private continuity,
conversations, tools, and access to the owner's real Omarchy desktop. It runs on
the owner's machine; no Ghost service holds a cloud copy.

Status and unfinished work live in GitHub issues (#17 is the beta gate). Stable
storage, wire, runtime, and package boundaries live in
[`CONTRACTS.md`](../CONTRACTS.md). Code owns behavior.

## Desired end state

An owner installs Ghost, creates a named persona, binds a local or open-source
model as its driver, adds a subscription or API key for the frontier teacher and
specialists, and talks through the HUD or `ghost` CLI. Pi is the default runtime; an installed Claude
Code is an optional native runtime. Both feel like the same ghost because they
receive the same character, notes policy, machine skills,
owner-context policy, and trusted-project snapshot. The runtime still owns its native way of
working.

The official repository stays a narrow, opinionated core. Owners extend a ghost
with readable instructions, skills, rules, Markdown commands/prompts, models,
and MCP. Executable project extensions wait for a real per-session isolation
boundary. Generic capabilities should graduate into core or upstream rather
than becoming parallel Ghost frameworks.

## Decisions that are not obvious from code

- **Local-first driver.** The ghost's main model, the `chat_model` role, is an
  open-source model: local on the owner's device, or hosted with one LoRA
  adapter per ghost. `openAiCompatiblePreset` already binds Ollama, vLLM,
  llama.cpp, or LM Studio at zero cost, and a runner listening on its
  well-known loopback port is detected automatically and drives the ghost when
  nothing else is bound. Frontier models bind only to the teacher and
  specialist roles,
  `advisor_model`, `task_model`, and `slow_model`, and are reached through
  `ghostd hook-smol-complete --role advisor` from an owner `session_stop` hook
  and through the specialist CLIs the ghost runs from Bash. Those owner hooks
  are the training signal for the continual-learning flywheel in #64; the
  core keeps no review pipeline or training journal of its own. The adapter
  trains on the owner's GPU when there is one and otherwise, per ghost and by
  opt-in, on Fireworks AI through the owner's own account with only redacted
  hook output leaving the machine; the adapter stays downloadable so it can
  be served locally later, behind one provider-agnostic adapter-host seam.
- **Lean core, adaptive ghost.** The core ships sensible defaults and stops
  there. A ghost fits its owner through character, notes, hooks, and its own
  checkout (#65), not through the core growing a feature per preference. The
  system prompt is a budget rather than a place to put things, because it is
  what the adapter has to absorb.
- **Three persistence scopes.** Character and subjective continuity are
  ghost-private. Owner-visible knowledge, preferences, decisions, notes, plans,
  and tasks live in the owner's Documents directory. Projects and machine
  artifacts remain owned by their native facility.
- **The owner's documents are the shared store.** Ghost names that directory in
  the prompt and reads it with the runtime's native file and search tools.
  Ghost has no notes database, task store, plan mode, or document index.
- **Files over an application database.** Personas and inspectable policy stay
  greppable and backup-friendly. Derived runtime state is isolated under
  `.pi/`, including pi's own 0600 credential file.
- **Runtime-native behavior wins.** Ghost projects policy through Pi and Claude
  Code's supported settings/hooks. It adds machinery only for product boundaries
  the runtimes do not own: persona lifecycle, daemon sessions, the HUD, browser
  relay, desktop sidecar, shared authentication policy, and recoverable moves.
- **No delegation subsystem.** A ghost that needs a specialist runs the
  owner's installed `pi`, `codex`, or `claude -p` from its own Bash, like any
  other command. Ghost keeps no task records, scopes, or worker API.
- **Self-maintenance through the machine's own facilities.** A ghost may edit,
  build, and restart its own source. The clone it is allowed to touch is named
  by `self.checkout` in its `settings.yml` and is bound like any other trusted
  project; git is the code history and the rollback, journald
  (`journalctl --user -t ghostd`) is the lifecycle history, systemd is the
  guardian (`systemd-run --user` hands off `systemctl --user restart ghostd`,
  so the restarter outlives the daemon it restarts), and Omarchy's snapper
  snapshots are the system rewind. Taking the direction from
  [exo](https://github.com/exoharness/exo) but not its machinery, Ghost
  deliberately builds no container sandbox with snapshot and rewind, no
  rebuild-and-restart tool, no event-log subsystem, no self-map beyond
  `CLAUDE.md` and `CONTRACTS.md`, and no canary automation. The runbook is
  [`docs/self-maintenance.md`](self-maintenance.md).
- **One visible browser.** Ghost drives the owner's signed-in Chromium through
  the opt-in relay. A second ghost profile was removed because the owner could
  not see it and the tab is the useful isolation unit.
- **Quickshell, not a web-app window.** The HUD and bar indicator belong to the
  Omarchy desktop. The remote viewer is deliberately narrower and opt-in over
  Tailscale Serve.
- **Owner-local trust.** There is one owner role. Remote guests are read-only;
  project trust is explicit and filesystem-identity bound; ambient provider
  credentials and executable project code are not discovered.
- **No artificial throttles.** Ghost surfaces provider/runtime limits and uses
  their retry/fallback chains. It does not impose turn, concurrency, hosted
  session, or spend caps.
- **Apache-2.0 and a fresh public history.** The predecessor history carried
  private identifiers; this repository is the open collaboration boundary.

## Product shape

The useful idea is an always-available AI teammate with a name, a chat thread,
tools, and continuity. Ghost's distinction is local custody: the persona works
on the owner's actual Linux desktop, its private state is readable, shared notes
remain the owner's own files, and credentials remain in machine-native
stores. That custody covers Ghost's own source: a ghost maintains the clone the
owner names for it, and every way back is a facility the machine already has.

Onboarding is: create a ghost → bind a local or open-source driver, then
optionally a subscription or API key for the teacher and specialist roles →
summon the HUD → talk. Nothing owner-level has to be installed or verified
first.
