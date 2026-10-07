# Concepts

What a ghost is, where its state lives, which surface owns what, the decisions
that are not obvious from the code, and which absences are deliberate.
[`CONTRACTS.md`](../CONTRACTS.md) is the normative boundary and the code beside
its tests is the behavior; nothing here restates either. For the first install
and first conversation, see [getting-started.md](getting-started.md).

Status and unfinished work live in GitHub issues.

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
  itself ([`persona.ts`](../packages/extensions/src/persona.ts)).
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
([`prompt-policy.ts`](../packages/daemon/src/prompt-policy.ts)).

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

Because the documents are the state, a conversation left idle for three
minutes gets one handoff pass on its own harness session that brings them up
to date, then, after a 15-second window to cancel, a "What should we work on
next?" turn, up to 100 since the owner last wrote. It is Ghost's only
background work of its own: a harness turn ends when its answer does, and an
owner who walks away would otherwise leave the documents behind and the ghost
idle.

The Documents directory is resolved the way screenshots resolve the Pictures
directory: `XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`.
Ghost never hard-codes a path, never indexes the directory, and never injects
any of it at session start. The system prompt names the directory in one
sentence, and the ghost reads it with the harness's native file and search
tools when a request may depend on it.

## Surfaces

| Surface | Owns | Code |
|---|---|---|
| `ghostd` daemon | conversations and their log, the choice of harness, MCP, hooks, the HTTP API | [`server.ts`](../packages/daemon/src/server.ts), [`session-host.ts`](../packages/daemon/src/session-host.ts) |
| `ghost` CLI | a terminal client over that API, with a named verb for every daemon capability | [`cli/main.ts`](../packages/daemon/src/cli/main.ts) |
| Ghost shell plugin | the Omarchy desktop surfaces: chat, roster, panes, bar dot | [`packages/shell/qml/`](../packages/shell/qml) |
| Chromium extension | the opt-in MV3 extension that lends the ghost the browser the owner already uses — its own product, in its own repo | [ghost-chromium-extension](https://github.com/ferdousbhai/ghost-chromium-extension) |
| `ghost-desktop` | computer use as a stdio MCP server (`desktop_look`, `desktop_act`), usable by any MCP client — its own product, in its own repo | [ghost-desktop](https://github.com/ferdousbhai/ghost-desktop) |

The daemon is the only conversation owner: one process owns a conversation, and every
other surface is a client. The CLI never edits a ghost home directly, and the
HUD never writes daemon-validated state behind the daemon's back; the workbench
file editor is the one deliberate exception, and it writes ordinary files at
the owner's explicit direction.

Computer use is CLI-first: the ghost is told to discover a route with
`omarchy commands --json` and run `omarchy <group> <action>` through Bash, and
to reach for `desktop_look` / `desktop_act` only when Omarchy has no route,
a route failed, or the work is inside an arbitrary application's window.
`ghost_browser` drives pages. `ghost-desktop` is the fallback, not the first move. If background computer use arrives from Omarchy or a third party, the fallback ops go with it.

There is one browser. Until the owner pairs the relay with their own Chromium,
browser calls fail and say so. There is no second backend and no dedicated
ghost profile, because the tab is the useful isolation unit and a browser the
owner cannot see is a browser they cannot supervise. The ghost therefore acts
inside the owner's logged-in session; the extension's README states the risk
that carries. If WebMCP is widely adopted, the relay goes with it: pages
would carry the standard surface and the extension becomes machinery nothing
needs.

## Harnesses

Every conversation turn is a headless run of an agent CLI the owner already
has — Claude Code, Codex, Grok, Copilot, OpenCode, pi, and the others Omarchy
installs — started in the conversation's own directory under the ghost home,
with the persona written there as `AGENTS.md` and the ghost's tools offered
over MCP. The harness brings the model, the sign-in, the tool loop,
permissions, compaction, and retries, all configured by the owner exactly as
when they run it by hand. Ghost brings the character, the conversation log,
the owner's hooks, and the choice of harness.

The choice is per turn, and a harness that cannot start (not signed in, out
of quota) hands the turn to the next with the conversation so far; the order
is in [`CONTRACTS.md`](../CONTRACTS.md) under "Harnesses". That is how a ghost
spends the owner's subscriptions and limits rather than a per-token API key
of its own; with none yet, OpenCode's free models answer.

The session receives the Ghost-owned context: the character and the stable
policy sections, listed in `prompt-budget.test.ts`. Each says only what the
ghost cannot learn elsewhere, every turn; a procedure it needs now and then
(timers, background jobs, handoffs, its own restart) is a `ghost help` topic
the section points at.

### Why no runtime of its own

Ghost embedded pi as its only runtime until 2026-10-03, and Claude Code as a
second until 2026-09-15. Both times the embedded loop was a second copy of
something the owner already had installed and signed in: the model catalog,
provider logins, compaction, context windows, an `ask` tool, slash commands,
branchable transcripts, and a patched dependency, roughly 20,000 lines plus
the pi packages in the install. Running the owner's harnesses directly
deletes all of it; the cost is one row per harness — launch flags and an
output parser, tested against real output — and features that were pi's
alone: mid-turn steering (a follow-up now runs after the current pass), the
structured `ask` (a question is an ordinary reply), forks, and model choice
inside Ghost (it is the harness's).

## Extending a ghost

A ghost is extended with readable files, not code: its `character.md` (which
also carries the owner's standing instructions), skills (linked into each conversation
directory where harnesses look for project skills), and MCP servers in the
ghost home. Machine skills are whatever each harness discovers on its own.
Project settings belong to a delegated harness run with the project directory
as its own cwd.

Machine-level command hooks (`before_prompt`, `session_stop`) are the owner's
`hooks.json`, editable by the ghost itself through `ghost hooks`; Ghost ships
none. The protocol is in [hooks.md](hooks.md).

## Decisions that are not obvious from code

- **The owner's harnesses drive.** A ghost's turns run on the agent CLIs the
  owner already has (see "Harnesses"); a local or per-ghost model arrives the
  same way, as a harness pointed at it, not as a runtime inside Ghost. Owner
  `session_stop` hooks are the training signal for any continual-learning
  loop an owner builds outside the core (#64); Ghost keeps no review pipeline
  or training journal of its own.
- **Lean core, adaptive ghost.** The core ships sensible defaults and stops
  there. A ghost fits its owner through character, notes, hooks, and its own
  checkout, not through the core growing a feature per preference. The
  system prompt is a budget rather than a place to put things, because it is
  what the adapter has to absorb.
- **Files over an application database.** Personas, conversation logs, and
  inspectable policy stay greppable and backup-friendly. Each harness keeps its
  own session store and credentials where it always does.
- **Harness-native behavior wins.** Ghost adds machinery only for product
  boundaries no harness owns: persona lifecycle, the conversation log across
  harnesses, the HUD, browser relay, `ghost-desktop`, shared authentication
  policy, and recoverable moves.
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

- **No plan mode, todo store, or plan/todo API.** A harness's native planning
  may exist inside a turn, but durable owner-visible plans and tasks belong in
  the owner's documents.
- **No private memory store and no document index.** Notes are files in the
  owner's documents; the directory is named in the prompt and read on demand.
  The board is the same idea: `board.md` there, rendered read-only by the HUD.
- **No trusted projects.** A conversation has its own directory, not a bound
  project tree whose instructions, skills, and MCP are scanned in; a ghost
  that wants a project's settings runs a harness there from Bash.
- **No delegation subsystem.** No worker scopes, `/tasks` API, or job
  control; a ghost runs `pi`, `codex`, or `claude -p` from Bash through
  `ghost delegate` when it wants a specialist, and that harness owns its own
  discovery, tools, and auth. `ghost delegate` only refuses a harness that is
  not installed or has no room and appends one receipt line per attempt, the
  evidence any change to how a ghost picks a harness has to be judged
  against; Ghost never reads it back. A delegated run reaches the ghost's
  browser and desktop only through `ghost mcp serve`, which runs the ghost's
  tools in the daemon.
- **No routing claims.** Nothing yet shows that how a ghost picks a harness
  improves outcomes beyond having room; the handoff receipts are how that gets
  measured, and nothing trains on them. A harness keeps its own tool loop and
  permissions: Ghost picks, launches, and records a run but does not steer it.
- **No second browser backend** and no separate ghost browser profile.
- **No credentials of Ghost's own.** Each harness signs in on its own; Ghost
  holds no key and scrubs nothing from the environment a harness inherits.
- **No compaction or context windows of Ghost's own.** A harness manages its
  context; Ghost's log hands a new harness the recent conversation.
- **No speech stack.** Dictation is Omarchy's Voxtype; the HUD only toggles
  it and mirrors its state file. The ghost does not speak.
- **No built-in hooks, review pipeline, or model catalog.** There is no model
  choice in Ghost at all; it is the harness's.
- **No job manager.** Background work is shell work: a ghost detaches a
  command and ends it with `ghost say --follow-up`, which wakes the
  conversation that started it. Ghost keeps no job table, jobs API, or jobs
  strip, and cannot cancel what it did not start.
- **No narration classifier.** Every text the ghost writes stays, as its own
  message: text that follows a tool call starts the next one, in the HUD and
  the tailnet viewer alike; in the HUD the calls belong to the message before
  them. No length limit or sentence rule decides what is "status".
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
- [hooks.md](hooks.md), [ghost-desktop](https://github.com/ferdousbhai/ghost-desktop#readme),
  [injection-defense.md](injection-defense.md) — one document per protocol.
- [self-maintenance.md](self-maintenance.md) — how a ghost edits and restarts
  itself; [`CONTRIBUTING.md`](../CONTRIBUTING.md) — how a ghost or a human
  sends a fix upstream; [packaging/release/README.md](../packaging/release/README.md) — how
  a release is cut and reaches Omarchy.
