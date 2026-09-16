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
| Ghost shell plugin | the Omarchy desktop surfaces: chat, roster, panes, bar dot | [`packages/shell/qml/`](../packages/shell/qml) |
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

## The runtime

Every conversation runs on pi. Conversation ids stay runtime-qualified
(`pi:<raw>`) so a stored id keeps saying what it is.

Ghost builds the session explicitly: its own model runtime, credential store,
settings, and resource snapshot, with pi's inherited system prompt, ambient
config/MCP, and automatic credential discovery kept out. Pi's native file,
search, Bash, steering, and branch behavior is kept; Ghost adds `ask`, browser,
screen, desktop, MCP, and context windows (`new_context`, `history`) in place of
summarizing compaction. Background work is shell work: a detached command that
ends with `ghost say --follow-up`.

The session receives the Ghost-owned context: character, first-meeting
policy, computer-use policy, other-harnesses policy (delegate from Bash,
check Omarchy's usage windows first, hand off through documents on a limit),
scheduled-work policy, self-maintenance policy, hooks policy, and
owner-context policy.

### Why one runtime

Ghost ran on Claude Code as a second chat runtime until 2026-09-15. It was
removed because a ghost delegates rather than does: it already runs `claude -p`
from Bash, on the owner's own Claude install, settings, and subscription, with
the harness's full tool set. Keeping Claude Code as a *chat* runtime bought
nothing that delegation does not, and cost 4,000 lines of adapter, a parallel
presentation-journal transcript store, a per-feature "not supported here" branch
on most session routes, and 460MB of bundled platform binaries in the install.

Upgrading across it needs nothing: a `models.json` that still names
`claude-code` in any role has that entry dropped the next time it is read, so
the chat role falls back to pi's catalogue default and the background roles
resolve themselves. Set the model you want with `ghost model <provider>/<id>`.

What that removal gives up, exactly: an owner can no longer spend a Claude
subscription on the ghost's own conversational turns — those now go through a
pi provider, billed per token or free. Delegated work still spends the
subscription. Bringing a second runtime back would have to beat that trade,
which is the same bar in `CONTRACTS.md` any second backend has to clear.

## Models and roles

`models.json` in the ghost home holds provider policy and role bindings.
Provider logins live in pi's own file-backed store,
`.pi/auth.json` (mode 0600), so each ghost signs in on its own and a login
never leaves the ghost home. Credential values never enter logs or API
responses.

Roles are `chat_model` (the conversation) and `smol_model` (titles, greetings,
command-hook completions), one binding each; retry and model fallback belong to
the runtime, not to `models.json`. The background role follows the driver when
unset: the chat provider's small tier, then the cheapest usable model anywhere.
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
  with one LoRA adapter per ghost. Frontier models are reached through the
  specialist CLIs the ghost runs from Bash (`claude -p`, `codex`, `pi`), not
  through a model role of Ghost's own: a teacher role existed and was removed
  once nothing but image reading depended on it. Owner `session_stop` hooks are
  the training signal for any
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
- **Runtime-native behavior wins.** Ghost projects policy through pi's
  supported settings and hooks. It adds machinery only for product
  boundaries the runtime does not own: persona lifecycle, daemon sessions, the
  HUD, browser relay, desktop sidecar, shared authentication policy, and
  recoverable moves.
- **Self-maintenance through the machine's own facilities.** A ghost may edit,
  build, and restart its own source. The clone it is allowed to touch is the
  one the daemon runs from, shared by every ghost on the machine, so one
  ghost's change powers them all; git is the code history and the
  rollback, journald is the lifecycle history, systemd is the guardian, and
  Omarchy's snapper snapshots are the system rewind. Ghost builds no sandbox,
  no rebuild-and-restart tool, no event log, and no canary automation. The
  runbook is [self-maintenance.md](self-maintenance.md).
- **One visible browser.** Ghost drives the owner's signed-in Chromium through
  the opt-in relay. A second ghost profile was removed because the owner could
  not see it and the tab is the useful isolation unit.
- **A plugin in Omarchy's shell, not a shell of its own.** The HUD and bar dot
  belong to the Omarchy desktop and run inside `omarchy-shell` as the
  `ferdousbhai.ghost` plugin. Ghost hosted its own Quickshell process until
  2026-09-13; that bought a second process, a systemd unit, a Python tray
  helper, and a copy of the bar widget that could not reach the daemon
  singletons, and all of it went when the plugin replaced it. The remote viewer
  is deliberately narrower and opt-in over Tailscale Serve.
- **Apache-2.0 and a fresh public history.** The predecessor history carried
  private identifiers; this repository is the open collaboration boundary.

## Deliberate absences

If you expect one of these, it is missing on purpose:

- **No plan mode, todo store, or plan/todo API.** A runtime's native planning
  may exist inside a turn, but durable owner-visible plans and tasks belong in
  the owner's documents.
- **No private memory store and no document index.** Notes are files in the
  owner's documents; the directory is named in the prompt and read on demand.
  The board is the same idea: `board.md` there, rendered read-only by the HUD.
- **No trusted projects.** A conversation has a cwd, not a bound project tree
  whose instructions, skills, and MCP are scanned in. Plugins, executable hooks
  and tools beyond the ghost's own, LSP, and subagents stay disabled; a ghost
  that wants a full harness runs it from Bash with the owner's own settings.
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
- **No job manager.** Background work is shell work: a ghost detaches a
  command and ends it with `ghost say --follow-up`, which wakes the
  conversation that started it. Ghost keeps no job table, jobs API, or jobs
  strip, and cannot cancel what it did not start.
- **No narration classifier in the HUD.** The reading column shows the latest
  text of a turn; each tool call overwrites the text that announced it, and
  that text survives as the tool card's intent. No length limit or sentence
  rule decides what is "status".
- **No compositor plugin for background input.** Wayland lets input reach
  only the focused window, so the helper's focus-borrowing transactions,
  restore logic, and honesty metadata exist to make that safe and visible.
  A Hyprland plugin with an independent seat would let those go, but only as a
  replacement, never as a second backend beside them, and only once the seat
  is a maintained interface rather than a plugin pinned to one Hyprland
  commit. Until then the ghost tells the owner when a shot or a click
  disturbed the desktop instead of pretending it did not.
- **No auto-updater.** The daemon only reports a newer release
  (`GET /api/status`, `ghost status`, the HUD line); Omarchy's package pipeline
  installs it, and a checkout is the owner's to pull.
- **No throttles**, as above.

## Where to go next

- [getting-started.md](getting-started.md) — install and first conversation.
- [`CONTRACTS.md`](../CONTRACTS.md) — the normative wire, storage, and package
  boundaries.
- [hooks.md](hooks.md), [desktop-helper.md](desktop-helper.md),
  [injection-defense.md](injection-defense.md) — one document per protocol.
- [self-maintenance.md](self-maintenance.md) — how a ghost edits and restarts
  itself; [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how a ghost or a human
  sends a fix upstream; [packaging/release/README.md](../packaging/release/README.md) — how
  a release is cut and reaches Omarchy.
