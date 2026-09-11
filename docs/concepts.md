# Concepts

What a ghost is, where its state lives, which surface owns what, the decisions
that are not obvious from the code, and which absences are deliberate.
[`CONTRACTS.md`](../CONTRACTS.md) is the normative boundary and the code beside
its tests is the behavior; nothing here restates either. For the first install
and first conversation, see [getting-started.md](getting-started.md).

Status and unfinished work live in GitHub issues (#17 is the beta gate).

## One owner, one machine

Ghost is a local AI persona for one owner: character, conversations, tools, and
access to the owner's real Omarchy desktop. It runs on the owner's machine; no
Ghost service holds a cloud copy. There is exactly one trust role, the owner.
Remote access exists only as the opt-in Tailscale Serve viewer, where the
configured owner has full access and admitted tailnet guests are read-only;
remote access never widens a ghost's local tool authority.

## Ghosts and ghost homes

A **ghost** is one persona. Its **ghost home** is one directory,
`~/ghosts/<name>/` by default, and the directory name *is* the ghost's name.
Creating a ghost writes `character.md`; everything else in the layout appears
when it is used ([`ghosts.ts`](../packages/daemon/src/ghosts.ts),
[`home.ts`](../packages/extensions/src/home.ts)).

- `character.md` is the persona: plain Markdown, no frontmatter, read fresh at
  the start of every session. While it is still the daemon-written seed, the
  ghost carries a first-meeting section that asks it to learn about the owner
  in the gaps and to show a character draft before writing one. Writing the
  file removes that section on the next conversation, so onboarding ends by
  itself ([`greeting.ts`](../packages/daemon/src/greeting.ts)).
- Notes are not in the home: a ghost's facts, decisions, and reflections are
  Markdown files under the owner's Documents directory, shared with every
  ghost and the owner.
- Sessions, sidecars, and runtime scratch state live under the same home.

The home is the atomic lifecycle unit. Rename moves the directory, so every
conversation id stays valid; delete moves it to the freedesktop Trash. Ghost
never recursively removes a home, and neither operation touches credentials,
owner documents, screenshots, downloads, or timers.

## Three state scopes

Everything durable belongs to exactly one of three scopes. Choosing the wrong
one is the most common modelling mistake in this system, so the boundary is
enforced in the system prompt as well as in code
([`machine-skills.ts`](../packages/daemon/src/machine-skills.ts)).

| Scope | Holds | Owned by |
|---|---|---|
| Ghost-private | character, conversations, settings, runtime sidecars | one ghost home |
| Owner-shared | notes, knowledge, decisions, plans, tasks | the owner's XDG Documents directory, read and written as ordinary files |
| External | downloads, screenshots, systemd user timers, credentials | the machine facility that already owns them |

There is no ghost-private memory store. Owner facts, preferences, decisions,
durable tasks, and the ghost's own reflections go to the owner's documents,
where the owner and every other ghost can see them. Finished deliverables go to
the destination the owner asked for, the documents directory when none was
named, and never into a ghost home.

The Documents directory is resolved the way screenshots resolve the Pictures
directory: `XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`.
Ghost never hard-codes a path, never indexes the directory, and never injects
any of it at session start. The system prompt names the directory in one
sentence, and the ghost reads it with the runtime's native file and search
tools when a request may depend on it.

## Surfaces

| Surface | Owns | Code |
|---|---|---|
| `ghostd` daemon | sessions, state transitions, models, credentials, MCP, hooks, the HTTP API | [`server.ts`](../packages/daemon/src/server.ts), [`session-host.ts`](../packages/daemon/src/session-host.ts) |
| `ghost` CLI | a terminal client over that API, with a named verb for every daemon capability | [`cli/main.ts`](../packages/daemon/src/cli/main.ts) |
| Quickshell HUD | the Omarchy desktop surfaces: chat, roster, panes, tray, bar indicator | [`packages/shell/qml/`](../packages/shell/qml) |
| Chromium relay | the opt-in MV3 extension that lends the ghost the browser the owner already uses | [`packages/chromium-extension/`](../packages/chromium-extension/extension) |
| Desktop helper | the Python JSON-lines computer-use sidecar (AT-SPI, capture, input) | [`docs/desktop-helper.md`](desktop-helper.md) |

The daemon is the only session owner: one process owns a session, and every
other surface is a client. The CLI never edits a ghost home directly, and the
HUD never writes daemon-validated state behind the daemon's back; the workbench
file editor is the one deliberate exception, and it writes ordinary files at
the owner's explicit direction.

Computer use is CLI-first: the ghost is told to discover a route with
`omarchy commands --json` and run `omarchy <group> <action>` through Bash, and
to reach for `ghost_desktop` / `ghost_screen` only when Omarchy has no route,
a route failed, or the work is inside an arbitrary application's window.
`ghost_browser` drives pages. The helper is the fallback, not the first move.

There is one browser. Until the owner pairs the relay with their own Chromium,
browser calls fail and say so. There is no second backend and no dedicated
ghost profile, because the tab is the useful isolation unit and a browser the
owner cannot see is a browser they cannot supervise. The ghost therefore acts
inside the owner's logged-in session; the extension's README states the risk
that carries.

## The two runtimes

A conversation runs on one of two agent harnesses. Conversation ids are
runtime-qualified (`pi:<raw>`, `claude-code:<raw>`).

- **Pi** is the default. Ghost builds the session explicitly: its own model
  runtime, credential store, settings, and resource snapshot, with pi's
  inherited system prompt, ambient config/MCP, and automatic credential
  discovery kept out. Pi's native file, search, Bash, steering, and branch
  behavior is kept; Ghost adds `ask`, background jobs, browser, screen,
  desktop, MCP, and context windows (`new_context`, `history`) in place of
  summarizing compaction.
- **Claude Code** is optional and native-first: `claude-code/default` runs the
  official Claude Agent SDK against the owner's installed, unmodified `claude`,
  authenticated by any method its own CLI reports as logged in. Ghost never
  receives or stores that credential. Claude gets the same tool capabilities
  as pi (an explicit native list, not its full preset) and Ghost adds the
  same Ghost tools on both. Setup is in
  [claude-code-runtime.md](claude-code-runtime.md).

Both runtimes receive the same Ghost-owned context: character, first-meeting
policy, computer-use policy, scheduled-work policy, self-maintenance policy,
hooks policy, and owner-context policy. Owner questions, image understanding,
and browser/screen/desktop control work on both. The runtime still owns its
own mechanics, so the same ghost feels like itself on either while working the
way that harness works.

One capability gap is deliberate and stays visible in the API rather than
being papered over: an MCP row that carries a credential is admitted by pi and
skipped by Claude, because Claude Code would copy it into its own session
storage outside the ghost home.

## Models and roles

`models.json` in the ghost home holds provider policy, role bindings, and
fallback chains. Provider logins live in pi's own file-backed store,
`.pi/auth.json` (mode 0600), so each ghost signs in on its own and a login
never leaves the ghost home. Credential values never enter logs or API
responses.

Roles are `chat_model` (the conversation), `smol_model` (titles, greetings,
command-hook completions), and `advisor_model` (the frontier teacher and image
reader), each with an optional fallback chain. The two background roles follow
the driver when unset: a Claude Code ghost gets Sonnet and Fable through Claude
Code, a pi ghost gets its provider's small tier and Ghost's advisor preference.
`chat_model` unset leaves the choice to pi. There is no model catalog API and
no local-runner detection: `ghost model <provider>/<id>` writes the binding,
and a local endpoint is an ordinary provider in `models.json`.

Ghosts run unthrottled. Provider, runtime, and context limits surface as typed
errors and use the runtime's own retry and fallback chains; Ghost adds no turn,
concurrency, hosted-session, or spend cap.

## Extending a ghost

A ghost is extended with readable files, not code: instructions, skills, rules,
Markdown commands and prompts, and MCP servers in the ghost home. Machine skills under
`~/.agents/skills/` and `~/.pi/agent/skills/` enter at lowest precedence, then
ghost-home resources. There is no skill-name allowlist, and the admitted set is
an immutable per-session snapshot the owner can inspect through the session
resources API. The directory a conversation works in is only its cwd: nothing
is discovered from it, and `!cd` moves a pi conversation there durably.

Machine-level command hooks (`before_prompt`, `session_stop`) are the owner's
`hooks.json`, editable by the ghost itself through `ghost hooks`; Ghost ships
none. The protocol is in [hooks.md](hooks.md).

## Decisions that are not obvious from code

- **Local-first driver.** The ghost's main model, the `chat_model` role, is
  meant to be an open-source model: local on the owner's device, or hosted
  with one LoRA adapter per ghost. Frontier models bind to the teacher role,
  `advisor_model`, reached through `ghostd hook-smol-complete --role advisor`
  from an owner `session_stop` hook and through the specialist CLIs the ghost
  runs from Bash. Those owner hooks are the training signal for any
  continual-learning loop an owner builds outside the core (#64); Ghost keeps
  no review pipeline or training journal of its own.
- **Lean core, adaptive ghost.** The core ships sensible defaults and stops
  there. A ghost fits its owner through character, notes, hooks, and its own
  checkout, not through the core growing a feature per preference. The
  system prompt is a budget rather than a place to put things, because it is
  what the adapter has to absorb.
- **Files over an application database.** Personas and inspectable policy stay
  greppable and backup-friendly. Derived runtime state is isolated under
  `.pi/`, including pi's own 0600 credential file.
- **Runtime-native behavior wins.** Ghost projects policy through Pi and Claude
  Code's supported settings and hooks. It adds machinery only for product
  boundaries the runtimes do not own: persona lifecycle, daemon sessions, the
  HUD, browser relay, desktop sidecar, shared authentication policy, and
  recoverable moves.
- **Self-maintenance through the machine's own facilities.** A ghost may edit,
  build, and restart its own source. The clone it is allowed to touch is named
  by `self.checkout` in its `settings.yml`; git is the code history and the
  rollback, journald is the lifecycle history, systemd is the guardian, and
  Omarchy's snapper snapshots are the system rewind. Ghost builds no sandbox,
  no rebuild-and-restart tool, no event log, and no canary automation. The
  runbook is [self-maintenance.md](self-maintenance.md).
- **One visible browser.** Ghost drives the owner's signed-in Chromium through
  the opt-in relay. A second ghost profile was removed because the owner could
  not see it and the tab is the useful isolation unit.
- **Quickshell, not a web-app window.** The HUD and bar indicator belong to
  the Omarchy desktop. The remote viewer is deliberately narrower and opt-in
  over Tailscale Serve.
- **Apache-2.0 and a fresh public history.** The predecessor history carried
  private identifiers; this repository is the open collaboration boundary.

## Deliberate absences

If you expect one of these, it is missing on purpose:

- **No plan mode, todo store, or plan/todo API.** A runtime's native planning
  may exist inside a turn, but durable owner-visible plans and tasks belong in
  the owner's documents.
- **No private memory store and no document index.** Notes are files in the
  owner's documents; the directory is named in the prompt and read on demand.
- **No trusted projects.** A conversation has a cwd, not a bound project tree
  whose instructions, skills, and MCP are scanned in. Plugins, executable hooks
  and tools beyond the ghost's own, LSP, and subagents stay disabled on both
  runtimes; a ghost that wants a full harness runs it from Bash with the
  owner's own settings.
- **No delegation subsystem.** No task records, worker scopes, or `/tasks`
  API; a ghost runs `pi`, `codex`, or `claude -p` from Bash when it wants a
  specialist, and that harness owns its own discovery, tools, and auth.
- **No second browser backend** and no separate ghost browser profile.
- **No ambient credentials.** Provider and cloud environment variables are
  scrubbed before the pi runtime is built
  ([`env-scrub.ts`](../packages/daemon/src/env-scrub.ts)).
- **No summarizing compaction on pi.** A full context rolls over into a new
  window with the ghost's own handoff; earlier windows stay searchable through
  `history`.
- **No speech stack.** Dictation is Omarchy's Voxtype; the HUD only toggles
  it and mirrors its state file. The ghost does not speak.
- **No built-in hooks, review pipeline, or model catalog.**
- **No throttles**, as above.

## Where to go next

- [getting-started.md](getting-started.md) — install and first conversation.
- [`CONTRACTS.md`](../CONTRACTS.md) — the normative wire, storage, and package
  boundaries.
- [hooks.md](hooks.md), [claude-code-runtime.md](claude-code-runtime.md),
  [desktop-helper.md](desktop-helper.md),
  [injection-defense.md](injection-defense.md) — one document per protocol.
- [self-maintenance.md](self-maintenance.md) — how a ghost edits and restarts
  itself; [packaging/release/README.md](../packaging/release/README.md) — how
  a release is cut and reaches Omarchy.
