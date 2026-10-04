# Contracts

Stable boundaries shared by Ghost's packages and clients. Change these in one
commit with every consumer. Implementation detail belongs in code and tests.

## Product boundary

Ghost is an owner-local Omarchy application: one owner, one machine, any number
of ghosts.

The harness stays lean and extendable, and it gets there by subtraction: from
2026-09-13 on, work here simplifies and never adds complexity. A change
states what it deletes, or why nothing could be. A capability the runtime,
the shell, Omarchy, or an installed CLI already provides is used, not
rebuilt. An external component is adopted only when it replaces machinery of
ours outright, never as a second backend beside it. New surface area (a tool,
a route, a setting, a background loop) needs a constraint that nothing
existing can meet, named in this file. The first existing thing is always an
installed CLI plus a skill: Bash and the harness's skill discovery already
reach every CLI on the machine, so a new built-in tool, route, or sidecar op
has to beat that pair at something neither can do. What Omarchy ships is free to depend
on; the install budget below is for everything else.

Installed size is part of that budget. A dependency is weighed by what it
adds to the install, not only by the code it saves, and a second
implementation of something Ghost already has is paid for twice — once in
branches, once in bytes. Ghost bundles no agent runtime for exactly this
reason: a conversation turn is a headless run of an agent CLI the owner
already has (Omarchy installs a dozen), on the owner's own subscription and
limits, so Ghost owns the persona, the conversation log, and the choice of
harness, and no model, loop, or credential (see "Harnesses" below and
[`docs/concepts.md`](docs/concepts.md)).

When a rule here fights the task, the
answer is to say so and get the owner's decision, not to add a special case.
[`docs/concepts.md`](docs/concepts.md) lists what is deliberately absent and
what would have to change for each absence to end. `ghostd` owns sessions and state transitions; the Quickshell HUD,
terminal client, Chromium relay, and `ghost-desktop` are clients or sidecars.
The daemon listens on loopback unless the owner explicitly enables the built-in
Tailscale Serve viewer.

Durable state has three scopes:

- **Ghost-private:** character, conversations, settings, and runtime
  sidecars live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, plans, and tasks live in the
  owner's XDG Documents directory, which every ghost reads and writes with its
  runtime's native file and search tools.
- **External:** browser downloads, screenshots, systemd user timers, and
  each harness's credentials, settings, and own session store stay in the
  machine facility that owns them.

The Documents directory is resolved like the screenshot directory:
`XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`; never a
hard-coded path. It is persistent owner context, not a Ghost-owned store: Ghost
neither indexes it nor injects any part of it at session start, and the system
prompt only names the directory.

Document content is unaffected by creating, renaming, deleting, or
uninstalling a ghost.

There is no Ghost plan mode, todo store, or plan/todo API. Harness native
planning may exist, but durable owner-visible plans and tasks belong in the
owner's documents. The one owner-visible view of them is the board:
`board.md` in the documents directory, `##` headings as columns and list items
as cards, edited by the owner and every harness with file tools and rendered
read-only by the HUD, the tailnet viewer, and `ghost board` through
`GET /api/board` ([`board.ts`](packages/daemon/src/board.ts)). Background work
is the shell's: Ghost keeps no job table (see "Background work and hooks").

## Ghost home (`ghost-home/v2`)

The default root is `~/ghosts`; each direct child is one ghost:

```text
~/ghosts/<name>/
  character.md
  skills/<name>/SKILL.md
  settings.yml         (`harness: <id>` prefers one harness)
  mcp.json
  sessions/<id>/       (one directory per conversation)
```

The directory is the atomic lifecycle unit. Rename and deletion refuse a
ghost with a conversation running, wait out file work already in flight,
refuse new work until they finish, and move the whole home on the same
filesystem.
Deletion goes to freedesktop Trash, with a recoverable `.trash/` fallback for
`EXDEV`; Ghost never recursively removes a home. Machine credentials, owner
documents, screenshots, downloads, and timers are not moved with it.
The lifecycle implementation and crash recovery are in
[`session-host.ts`](packages/daemon/src/session-host.ts).

The checkout a ghost may edit is the clone the daemon was built from
(`GET /api/status` `source.root`), and it is the same for every ghost on the
machine: one daemon powers them all, so a self-edit powers all of them after a
build and restart. A packaged install has no checkout. No per-ghost setting
names one; the checkout's own skills, rules, and MCP never enter a session.
`settings.yml` names no cwd: every conversation runs in its own directory.

### Character and notes

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body, bounded by
`MAX_CHARACTER_BODY_LENGTH` in [`home.ts`](packages/extensions/src/home.ts),
is the persona. A seeded or blank character marks onboarding; the ghost shows
the owner a draft and waits for confirmation before replacing it.

There is no ghost-private memory store. A ghost's notes — owner facts,
decisions, tasks, and its own reflections — are Markdown files under the
owner's Documents directory itself, written and
read with the harness's native file tools, shared by every ghost and readable
by the owner. Nothing there is indexed or injected at session start.

### Ghost-home resources

`character.md` is the one persona file, the owner's instructions for this
ghost included; there is no ghost-home `AGENTS.md`. `skills/` is linked into each conversation directory as
`.claude/skills` and `.agents/skills`, where harnesses look for project
skills; machine skills are whatever each harness discovers itself. `mcp.json`
rows that are enabled and valid are handed to the harness each turn (see
"Harnesses"). A ghost home carries no executable extension code; the only
hooks are the owner's `hooks.json` commands. Nothing is discovered from any
other tree: a delegated harness run with a project directory as its own cwd
respects that project's settings.

### Conversations

A conversation is one directory, `sessions/<id>/`, with `<id>` 1–128 of
`[A-Za-z0-9._-]` not starting with `.`; clients mint ids (the HUD `hud-…`,
the CLI `cli-…`). The directory is
the harness's working directory and holds Ghost's log, `.conversation.jsonl`
([`conversation-log.ts`](packages/daemon/src/conversation-log.ts)): one JSON
object per line — the conversation header, owner and follow-up and hook
messages, the assistant's text and tool calls (a failed call marked
`failed`, a failed turn carrying `error`), the owner's `!` commands, title
records, and `harness` records naming the harness that took over and the
session id it reported. A torn last line is skipped. The log is the history
every client reads; each harness's own transcript is its resume state and is
not read back. A conversation is listed once a message lands or the owner
names it; each row carries `preview`, the first owner text. Pins and read
timestamps are bounded sidecars beside the directories. Deletion moves the
directory to recoverable Trash in one rename; there is no fork.

### Machine-owned artifacts

- Screenshots use the Omarchy/XDG Pictures directory and exact
  `ghost-<ghost>-{screen|browser}-<timestamp>.png` names. Retention touches only
  those names.
- Downloads are owned by the owner's Chromium configuration.
- Scheduled work is a systemd user `.timer`/`.service` pair named
  `ghost-timer-v1-<name-length>-<ghost>-<slug>`. Ghost prompts author persistent
  units; rename/delete retire units owned by that prefix. See
  [`schedules.ts`](packages/daemon/src/schedules.ts).
- Harness credentials are the harness's own, signed in by the owner with that
  harness; a turn spends the account Omarchy marks active for claude, codex,
  and grok (`omarchy-agent-account-home`). An MCP server's headers or env are
  literal values in the ghost's private `mcp.json`. Ghost keeps no keyring, no
  account allow-list, and no secret references.
- Finished artifacts go to the destination the owner requested, defaulting to
  the owner's Documents directory when none was named. Ghost keeps no index of
  it.

### State survival

What each kind of state does under the events that move it. "The home" is the
ghost home directory, which moves as one unit.

| State | Daemon restart | Ghost rename | Ghost delete | Rebuild + restart | Snapper rollback of `/` | Package reinstall |
| --- | --- | --- | --- | --- | --- | --- |
| `character.md` | survives | moves with the home; the character seed is rewritten to the new name | to Trash with the home | unchanged | unchanged | preserved |
| Conversations and sidecars under `sessions/` | survives; the log is the durable history | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| Each harness's own session store | the harness's; survives | not moved: the next turn in a moved conversation starts a fresh harness session handed the log | not removed | unchanged | unchanged | preserved |
| `settings.yml`, `mcp.json` | survives | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| Timers `ghost-timer-v1-*` | unaffected; systemd owns them | stopped and removed before the rename completes | stopped and removed before the delete completes | unchanged | persistent units unchanged; `$XDG_RUNTIME_DIR` units are tmpfs | preserved |
| Screenshots in the XDG Pictures directory | survive | not moved; filenames keep the old ghost name | not removed | unchanged | unchanged | preserved |
| The clone the daemon runs from | untouched | untouched | untouched | it is the source | unchanged | unchanged |
| The running build | re-execs the same build | unchanged | unchanged | replaced | a packaged install under `/usr` rolls back; a build from a clone under the home does not | replaced |

The rollback column assumes Omarchy's btrfs layout, where `/` is the `@`
subvolume and `/home` is `@home` with no snapper config of its own (verified
on Omarchy 4.0.0.alpha, 2026-09-11: snapper lists one config, `root`, for
`/`). On another layout, confirm before relying on the column:

```sh
findmnt -no SOURCE / /home
ls /etc/snapper/configs
```

Where `/home` is a separate subvolume that snapper does not cover, a rollback of
`/` restores the packaged install and system configuration and leaves every
ghost home, the persistent timer units, and the ghost's own checkout exactly
as they were. Nothing in this table is a
backup: Trash and snapper are undo, not retention.

## Runtime contract

Every turn's system prompt is the Ghost character and the stable policy
sections, whose authoritative list and per-section size ceilings are
[`prompt-budget.test.ts`](packages/daemon/test/prompt-budget.test.ts). Two sections carry contract the rest of this file
relies on: the other-harnesses policy runs each handoff with the project
directory as the harness's own cwd so the headless harness respects that
project's settings, launches each handoff through `ghost delegate`, which
refuses a harness without room, and ends a limit in a handoff note in the
owner's documents; the owner-context policy names the Documents directory in
one sentence and nothing else about it. Owner documents are read only when
relevant, with the harness's own file and search tools, never injected
automatically. The prompt is rendered before every turn, so a character the
ghost rewrote is who it is on the next one.

### Harnesses

A turn is one headless run of an agent CLI, a row of
[`harness-table.ts`](packages/daemon/src/harness-table.ts): how to launch it
non-interactively with permissions pre-approved, how to resume, how it takes
MCP servers, and a parser from its JSON output to text, tool start/end,
session, and error events; reasoning stays inside the harness. Rows exist for claude, codex, grok,
copilot, opencode, pi, omp, agy, cursor-agent, crush, and muse; their parsers
are tested against output each CLI really printed. That table is the one
per-harness adapter, and a row is launch flags plus a parser, never a chat
loop. Everything else — model, auth, tools, permissions, compaction, retries —
is the harness's own, configured by the owner exactly as when they run it.

The harness runs in the conversation directory with the conversation's
identity (`GHOST`, `GHOST_SESSION`) in its environment. Ghost writes the
persona there as `AGENTS.md`, with `CLAUDE.md` and `GEMINI.md` linking to it;
grok, which reads none of them, gets it as `--rules`. Because the directory is
the conversation's own, a harness's "continue the most recent session here" is
the conversation's resume; opencode and muse, whose continue is not
cwd-scoped, are resumed by the session id they reported. Each turn also
receives the `ghost` MCP server (`ghost mcp serve -g <ghost> -s <id>`, the
ghost's browser and desktop tools) and the ghost's enabled `mcp.json` rows,
`${VAR}`-expanded and with relative stdio `cwd`s resolved against the ghost
home, in that harness's own dialect: a `--mcp-config` file, `-c
mcp_servers.*` overrides, `OPENCODE_CONFIG_CONTENT`, or a project config file
in the conversation directory. A row is a stdio `command`/`args`/`env`/`cwd`
or a remote `url`/`headers`, plus `enabled` and the `envPolicy`/`headerPolicy`
expansion switches; any other field makes it invalid, since no harness dialect
carries it. pi has no MCP client.

Which harness answers is decided per turn
([`session-host.ts`](packages/daemon/src/session-host.ts)): the one already
carrying the conversation (or the one the owner or ghost switched it to),
then the ghost's `settings.yml` `harness`, then
Omarchy's default agent, then every other harness Omarchy reports installed
and eligible (`ghost harnesses`), each only if eligible. A harness that fails
before producing anything (not signed in, out of quota, not installed) hands
the prompt to the next; one that fails after answering ends the turn in an
error. A harness new to a conversation receives the newest
`HANDOFF_CONTEXT_CHARS` of the log as `<conversation-so-far>`; a continuing one
receives the owner's `!` commands it has not seen as `<owner-commands>`. The
owner's `!command` runs in the owner home with the conversation's identity
and is logged; `!!command` is logged but never handed on.

A turn takes no input mid-run: text queued while it runs (`/queue`, `ghost say
--follow-up`) runs as the next pass in the same stream. A
queued follow-up outranks a stop hook: no `session_stop` is asked while one
waits, and one sent while the hook runs replaces its continuation.
Aborting a turn signals the harness's process group, SIGTERM then SIGKILL,
and nothing else. Images, attachments, and model choice are the harness's.

### Background work and hooks

There is no `ask` tool: a question to the owner is an ordinary reply.

Background work is shell work: a ghost detaches a command
(`setsid -f`), logs to a file, and ends it with `ghost say --follow-up`, which
queues after a live turn or, when the conversation is idle, starts its next
turn. `GHOST` and `GHOST_SESSION` are in the Bash environment so
the CLI addresses the right conversation without flags. Ghost keeps no job
table, no jobs API, no jobs strip, and cannot cancel what it did not start;
the policy text is `BACKGROUND_WORK_POLICY` in
[`prompt-policy.ts`](packages/daemon/src/prompt-policy.ts).

There is no Ghost-owned delegation system: no worker scopes, `/tasks` API, or
job control. A ghost that wants a specialist runs the owner's installed `pi`,
`codex`, `omp`, or `claude -p` from its own Bash as `cd <dir> && ghost delegate
<harness> -- <args>` (`HARNESS_LIMITS_POLICY` in
[`prompt-policy.ts`](packages/daemon/src/prompt-policy.ts)); that harness runs
with the owner's own settings for it — its full tool set, project discovery,
auth, and session semantics.
`ghost delegate` runs `omarchy agent usage update --limits-only <harness>`
(ignoring its failure), then applies `ghost harnesses`: a harness not listed
exits 5, one listed ineligible exits 6, and neither runs. Otherwise the harness
runs in the foreground in the caller's cwd and process group, with the caller's
environment and stdin, its stdout and stderr streamed through unchanged; SIGINT
and SIGTERM are forwarded to it, and once it exits the verb stops reading when
its pipes have been idle for 100ms, so a descendant holding them cannot hang
the call. The verb exits with the harness's status (128 plus the signal number
when a signal ended it, 127 when it could not start).

A delegated harness can load the ghost's tools with `ghost mcp serve`, the
same stdio MCP server every conversation turn gets, which proxies
`tools/list` and `tools/call` to the `/sessions/:id/tools` routes, bound at
start to `-s`, then `$GHOST_SESSION` (which `ghost delegate` passes through);
an id not listed yet, a new conversation whose first turn is still running,
binds as given. Each serve process sends its own `caller` (the MCP client's
name plus a per-process id) with every call, which keys the desktop lease.
`ghost delegate` adds
it to the two harnesses whose flags for it are known, unless the run already
names an MCP config: `claude` gets `--allowedTools mcp__ghost --mcp-config
<ghost server>` after its own arguments (both flags take lists, and a `--`
in them leaves the run alone), `codex` gets `-c mcp_servers.ghost.command`
and `.args` overrides ahead of them. That table is a deliberate exception to
the harness table's being the one adapter: two flags per harness, and it
replaces a recipe every model had to copy exactly. Other harnesses load it
themselves (an omp `mcp.json` row); pi has no MCP client.

Every attempt, refused or run, appends one JSON line to
`$XDG_STATE_HOME/ghost/handoffs.jsonl` (falling back to `~/.local/state`; the
file is 0600, and past 1 MiB it moves to `handoffs.jsonl.1`, replacing the
previous one): `{v: 1, at, ghost, session, harness, pick, cwd, eligible, windows,
status, outcome}`, where `ghost` and `session` come from `$GHOST` and `$GHOST_SESSION`
(or `null`), `pick` is `"owner"` when `--owner-named` says the owner named the
harness or no `$GHOST` is set (the owner ran the verb), else `"ghost"`, `eligible` lists the harnesses eligible at the check, `windows` is
this harness's live windows then, `status` is Omarchy's note when it could not
measure this harness (an unmeasured harness is eligible, and this shows the
check was blind) or `null`, and `outcome` is `{refused}` with the reason,
or `{exit, signal, durationMs, limit}`, `durationMs` the harness's own run
time, `limit` being `classifyLimitMessage`'s kind for the last 8 KiB of output
of a run that did not exit 0, else `null`. No prompt text or arguments are
kept. A receipt that cannot be written is a warning on stderr, never a changed
exit status. The log is the evidence for judging routing; nothing in Ghost
reads it back. The owner's summary of it is `bun scripts/handoff-report.ts`
from a checkout, outside the shipped package: attempts, refusals by kind, exit
outcomes, unmeasured checks, and limits hit, per harness.

Awaited Ghost hooks are `before_prompt` and `session_stop`, run by ghostd
around each harness pass, above whatever hooks the harness has of its own.
Their JSON protocol, failure behavior, and settings are defined in
[`docs/hooks.md`](docs/hooks.md). A stop hook owns its continuation policy;
Ghost sets `stop_hook_active` on hook continuation passes and does not impose
a host bound; `owner_prompt` and `turn_id` identify one owner request across
its continuations.
`ghostd hook-smol-complete` gives a hook one completion from the ghost's
preferred harness ([`hook-complete.ts`](packages/daemon/src/hook-complete.ts)).
A ghost keeps its notes in the
owner's documents with its file tools during ordinary turns. Ghost runs no
background memory pass of its own.

Every `session_stop` and `before_prompt` behavior is a `hooks.json` command the
owner chooses. Ghost has no in-process hook registration to be the other kind,
so a status row carries only its event, name, and description; the `builtin`
section of that file admits no keys and parses only when empty.

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

Rows beginning `/sessions/` are relative to `/api/ghosts/:name`.

| Route | Contract |
|---|---|
| `GET /api/hooks` | Redacted hook status. |
| `GET /api/relay/status` | Unauthenticated relay liveness; carries no secret. `pairing` is `{ code, since }` while an unpaired browser waits for Allow, else `null`. |
| `POST /api/relay/pair` | Owner answers the pending pairing: `{ code, allow }`. Allow hands the relay token to that browser over its socket; a stale code is `404 pairing_not_found`. |
| `GET\|PUT /api/hooks/config` | Read or atomically replace the admitted `hooks.json`. |
| `GET /api/board` | The owner's `board.md`, parsed to columns and cards; bounded; readable by tailnet guests; never written through the API. |
| `GET /api/status` | Owner-only `{ version, source: { commit, root }, update }`. `root` is the git root of the running entry script, or `null` for the packaged install; a guest is refused the row rather than shown a filesystem path. `update` is the daily release check's last answer, `{ latest, command, url }` or `null`; `command` is what installs it on this machine (`omarchy-update` for the package, pull + build + restart for a checkout). Ghost never applies an update itself; `--offline` skips the check ([`update-check.ts`](packages/daemon/src/update-check.ts)). |
| `GET\|POST /api/ghosts` | List or create ghosts. |
| `PUT /api/ghosts/:name/name` | Rename a ghost and its whole home. |
| `DELETE /api/ghosts/:name?confirm=:name` | Move a ghost home to recoverable Trash. |
| `GET\|PUT /api/ghosts/:name/character` | Read or atomically replace the persona file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `GET\|POST\|PUT\|DELETE /api/ghosts/:name/mcp…` | Sanitized MCP catalog, mutation, and enablement. A server added through this API starts disabled unless its row says `enabled: true`; the next turn hands enabled rows to the harness, which connects them. |
| `GET\|PUT /api/ghosts/:name/harness` | `{ harnesses: [{id, eligible, reason, usage}], ghostDefault, omarchyDefault }`: the installed agents Ghost has a row for, with Omarchy's usage, the ghost's preferred agent (`settings.yml` `harness`, null for automatic), and Omarchy's default. `PUT { harness: id \| null }` sets or clears the preference, keeping the file's other keys; an id with no row is `400 unknown_harness`. |
| `PUT /sessions/:id/harness` | `{ harness: id }` → `{ id, harness }`: the conversation's next turn runs on that agent, handed the conversation so far; a conversation with no message yet may be pointed first. An agent a turn would pass over is refused, `409 harness_not_installed` or `harness_no_room` with the window, never silently ignored. |
| `POST /api/ghosts/:name/messages` | `{ prompt, sessionId? }` → one turn as the turn wire below; a missing `sessionId` is the conversation `default`. |
| `GET /api/ghosts/:name/events` | Conversation invalidation SSE; clients refetch affected state. |
| `GET /api/ghosts/:name/sessions` | Conversation rows `{ id, title, preview, harness, createdAt, updatedAt, messageCount, pinned, unread }`, pinned first, then newest. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `GET /sessions/:id/transcript` | Paged renderable history projected from the conversation log, `{ id, title, harness, messages, total, truncated, historyTruncated }`; a message's optional `contentTruncated: true` marks bounded stored text, `errorMessage` a failed turn. |
| `GET /sessions/:id/tools`, `POST /sessions/:id/tools/:name` | Machine-local token only (a tailnet caller, even the owner, gets 403 `local_only`). List the ghost's own tools (browser and desktop, `{name, description, inputSchema}`), or run one with `{arguments, caller?}` → `{content, isError}`; a tool's failure is `isError` with its message. The harness reports its own calls in the turn stream. |
| `GET\|POST /sessions/:id/queue` | Inspect (`{ streaming, count, followUp }`) or enqueue `{ text }` into a live turn; it runs as the next pass of the same stream. An idle conversation answers `409 session_not_streaming`; `ghost say --follow-up` then posts the text as a new turn instead. |
| `DELETE /sessions/:id` | Move the conversation directory to Trash. |
| `GET /api/remote/whoami` | Effective owner/guest identity. |
| `GET\|POST /api/remote` and `GET /api/remote/qr.svg` | Tailscale Serve status/control and active URL QR. |
| `GET /manifest.webmanifest` | Public viewer manifest. |

There are intentionally no `/plan`, `/todo`, `/live`, or `/collab` session
routes: Ghost ships no live-voice controller and no collaboration host, and
remote access is the tailnet viewer alone.

### Turn wire

The event union is the contract; clients must ignore unknown future event
types. See [`turn-events.ts`](packages/daemon/src/turn-events.ts). A turn
emits `start`, then ordered `text_*`, `tool_execution_*`, `owner_message` (a queued
follow-up starting its pass), `hook_start`/`hook_end` (an owner command hook
running, by its `name`), and `session_stop_continued` events, and exactly one
terminal `done` or `error`. A quota refusal is a typed `limit_reached`
event (harness, kind) sent before that `error`; the classifier is
`classifyLimitMessage`. Tool events carry the call id, tool name, the
conversation directory, and a bounded output summary. An owner `!command` is
one `bash` tool card, then `done`.

### `ghost` CLI

The terminal client never edits a ghost home; every command that changes ghost
state goes through the daemon. Its command catalog is defined in
[`cli/main.ts`](packages/daemon/src/cli/main.ts). Every daemon capability the
HUD reaches is a named verb there (ghost list, rename, character, sessions
and their title/pin/read/delete, the agent a ghost prefers (`ghost harness`)
and a conversation runs on (`ghost switch`), MCP, hooks, remote, status,
skill), so a
ghost can drive and verify itself from Bash without raw HTTP. `ghost help
<topic>` prints the recipes the system prompt only points at (`timers`,
`self`, `harnesses`; [`help-topics.ts`](packages/daemon/src/help-topics.ts)),
rendered for the ghost and session the shell's `$GHOST`/`$GHOST_SESSION` name
and needing no daemon; they are prompt-visible contract text like the policy
sections. `ghost harnesses` also reads locally, never through the daemon: the
agent ids in Omarchy's `omarchy default agent` choices (from `omarchy commands
--json`) that Omarchy's own `agent_present` test would call installed, in
that order: an `omarchy-install-<id>-cli --check` decides when that installer
exists, a first-run mise stub on `PATH` counts only once `mise where
<package>` succeeds for the package its `mise use -g` line names (so a pending
update is not a cold install), and any other executable on `PATH` is the
owner's own install. Each is
joined with its
Omarchy usage record, `$XDG_STATE_HOME/omarchy/agents/usage/<id>.json` (falling
back to `~/.local/state`). `--json` prints `{harnesses, refresh}`: each harness
is `{id, eligible, reason, usage}`, and `usage` is `null` without a record,
else `{updatedAt, stale, status, windows}` with each window `{label, percent,
resetsAt}`, `percent` a 0–1 fraction used. A harness is ineligible when any
window whose reset is still ahead is at 90% or more, or when a weekly one (a
label matching `week` or `7-day`, its reset at most a week off) has used more
than the fraction of its week elapsed since the reset plus one day's share
(1/7); `reason` then names the window, else it is `null`. The thresholds are
constants in [`harnesses.ts`](packages/daemon/src/harnesses.ts), not owner
settings. A record's `ready` only says Omarchy has data to show, so it
decides nothing. A window whose reset has
passed is dropped. `stale` marks a record older than 15 minutes; the verb never
refreshes one, and `refresh` is the Omarchy command that does. `-q` prints the
eligible ids, one per line. It keeps no state and throttles nothing. Addressing is
`-g`, then `$GHOST`, then the `ghost use` default, and `-s`, then
`$GHOST_SESSION`, then the latest conversation; a ghost's own shell, and the
owner's `!` commands in a conversation, carry both variables. Signing in is
the harness's own (`claude`, `codex login`, …); Ghost has no login or model
commands. There are no plan or todo commands.

## Limits and credentials

Ghost has no model, provider, or credential of its own: each harness reads its
sign-in from its own configuration exactly as when the owner runs it by hand,
and its environment is the daemon's own, unscrubbed. Credential values never
enter logs or API responses.

Ghosts run unthrottled. Harness limits surface as typed errors, and the
harness's own retry and fallback behavior applies; Ghost's one contribution is
the per-turn order of eligible harnesses above, judged from Omarchy's usage
records. Ghost adds no turn, hosted-session, concurrency, or spend cap. The
one deliberate exception is the
desktop lease (ghost-desktop's [`lease.ts`](https://github.com/ferdousbhai/ghost-desktop/blob/master/src/lease.ts)): there is one
pointer and one focus, so every `desktop_act` call claims the desktop for its
caller, and another caller's call fails `busy` naming the holder until the
holder has been idle 15 s. The lease is a file under
`$XDG_RUNTIME_DIR/ghost-desktop/`, shared by every `ghost-desktop` process of
the user, so a ghost and a separately launched MCP client (Claude Code) take
turns too. A caller is a call's `_meta.caller` — `ghost mcp serve` sends its
client and process — else the connecting client plus that server process.
`desktop_look` never claims and reports a foreign holder as `heldBy`.

## Package boundaries

Ghost is two sides of one product plus two separate products. **ghost-core**
is everything a second interface could reuse: `packages/daemon` and
`packages/extensions`. **ghost-omarchy** is the Omarchy-only surface:
`packages/shell` (published as `@ghost/omarchy`; the directory name is
historical) and `ghost-desktop`, its own repository. The sides meet only at named
seams — the daemon's HTTP/SSE API (which the `ghost` CLI also speaks), the
relay WebSocket protocol, and MCP over stdio with `ghost-desktop`'s PATH
spawn — and core never imports the Omarchy side:
`scripts/check-core-boundary.sh` (run by `pnpm lint`) proves it.

`packages/extensions` holds the persona and system-prompt assembly, the
ghost's tools (browser session, relay backend, desktop bridge), and the
untrusted-content fence; the daemon holds hook and MCP config policy.
Hosted SummonGhost vendors its own packed copy of the former
`@ghost/runtime` package (its `SOURCE.json` names the commit) and owns it.

The **relay extension** is a separate product in its own repository,
[ghost-chromium-extension](https://github.com/ferdousbhai/ghost-chromium-extension),
with its own version and store listing. It meets the daemon only at the relay
WebSocket protocol (its `PROTOCOL.md`; the daemon's mirror is
[`relay-protocol.ts`](packages/daemon/src/relay-protocol.ts)): neither side
imports the other's source, Ghost does not bundle or install it, and only
`PROTOCOL_VERSION` ties an extension release to a Ghost release. The daemon's
conformance test ([`relay-extension.test.ts`](packages/daemon/test/relay-extension.test.ts))
reads a checkout of the extension — `GHOST_CHROMIUM_EXTENSION_DIR`, else a
sibling clone `../ghost-chromium-extension` — and skips loudly without one,
so the gate is only complete with that clone beside this repository. That test
is the agreement: it compares the clone's constants against
`relay-protocol.ts`, so no release number is pinned in prose here. A relay
change that breaks the pair turns the suite red; bumping `PROTOCOL_VERSION` on
both sides in lockstep is what re-agrees them.

The Arch install has two packages built from the same release: `ghost-runtime`
owns the daemon, CLI, `ghost-desktop`, user unit, and runtime docs/licenses;
`ghost` owns the HUD, desktop launcher, icons, and shell snippets and depends on
that exact runtime version. The checkout variants are `ghost-runtime-dev` and
`ghost-dev`. Installing only the runtime keeps desktop/browser automation in the
existing graphical session without requiring Quickshell or installing Ghost UI.
An app supplies its own UI over the same authenticated HTTP/SSE API. Adding or
removing the UI neither stops the runtime nor changes ghost homes; removing the
runtime preserves owner data. This replaces the inseparable desktop package,
not the daemon, protocols, or graphical-session lifecycle.

- [`packages/extensions`](packages/extensions/src/index.ts) is runtime-neutral:
  ghost-home parsing, prompt construction, pure tools, browser/desktop clients,
  and the `extension-api.ts` seam. It imports no daemon or UI.
- [`packages/daemon`](packages/daemon/src/main.ts) owns configuration,
  authentication, conversations, the harness table, MCP, hooks, lifecycle,
  HTTP, and the `ghost` CLI. Bun is the production runtime.
- [`packages/shell`](packages/shell/qml/manifest.json) is the `@ghost/omarchy`
  package: an omarchy-shell plugin, id `ferdousbhai.ghost`, declaring `service`
  (the daemon connection and
  the notifications a shut window would swallow), `panel` (the chat window), and
  `bar-widget` (the state dot) kinds. It runs inside Omarchy's own shell
  process, so Ghost ships no shell, unit, or tray helper of its own, and its QML
  imports are relative paths: inside the host, `qs.` resolves to Omarchy's shell
  root. The bar widget claims a whole host slot — the injected `bar.barSize`
  across the bar, the host's 27px icon slot along it — because the host arranges
  modules in a Row, which sets `x` and leaves `y` alone: anything shorter rides
  above its neighbours instead of on their centre line. Hover text uses the
  host's `bar.showTooltip`/`hideTooltip` API and `tooltipHovered` lifecycle;
  Omarchy owns its theme, sizing, and placement. The widget exposes
  `triggerPress(button)` so the host's drag-aware click forwarding toggles the
  panel on left click through the injected `bar.shell` facade. The package installs it
  to `/usr/share/ghost/plugin`; the per-user symlink into
  `~/.config/omarchy/plugins/` belongs to the install script.
  The plugin is distributed only by the `ghost` package, never as a
  `omarchy plugin add` git checkout: the window and the daemon are one product
  and must be the same version, and a second channel cannot hold that lock.
  Desktop toasts belong to the shell service, not stop hooks. Completed turns,
  and terminal failures notify unless their conversation is
  being viewed in the focused chat panel. Cancellation is quiet. Toasts use
  the conversation title and a reply/error excerpt, replace live toasts
  per ghost and conversation using the notification server’s IDs, and open that
  conversation through a summon payload
  `{ "ghost": "name", "sessionId": "id", "section": "chat" }`, carried in
  Omarchy’s `omarchy-exec-argv` notification hint.
  It talks only to authenticated HTTP/SSE and never edits daemon-validated ghost
  state (character, control files) directly; the one deliberate
  exception is the workbench file editor, which writes ordinary files at the
  owner's explicit direction. Dictation is Omarchy's Voxtype: the shell runs
  `voxtype record toggle` and reads `$XDG_RUNTIME_DIR/voxtype/state`; Ghost
  ships no speech stack of its own.
- The [Ghost relay extension](https://github.com/ferdousbhai/ghost-chromium-extension)
  is the opt-in MV3 relay into the owner's Chromium, its own product in its
  own repository (seam: its `PROTOCOL.md`). It also drives those tabs for its
  own side-panel chat, on the owner's OpenRouter account, with no ghost
  installed; that mode is off the wire, but two of its rules are visible to a
  ghost. A workspace id beginning `local:` is the panel's, so a request naming
  the other side's tab is refused `invalid_input` by name (ghost-to-ghost stays
  `no_page`), and a ghostd incarnation change retires only ghost-owned claims.
  An unpaired extension dials
  `/relay` with a six-digit code (`RELAY_PAIR_SUBPROTOCOL_PREFIX`) instead of a
  token; the owner allows that code in the HUD or with `ghost browser allow`,
  and the daemon answers with a `paired` frame carrying the token (`pairing`
  frames every ping interval keep the waiting worker alive). Pairing and
  workspace ownership are capability-scoped; there is no second browser
  backend. Client text
  frames are capped at `MAX_RELAY_MESSAGE_BYTES`
  ([`relay.ts`](packages/daemon/src/relay.ts)) before JSON parsing.
- [ghost-desktop](https://github.com/ferdousbhai/ghost-desktop) is Hyprland computer use as a stdio MCP server
  with two tools, `desktop_look` (never changes the desktop) and `desktop_act`
  (ordered steps); any MCP client can run it. It is its own repository with
  its own version, pinned by tag in the root `package.json` and bundled into
  the runtime as `ghost-desktop` by
  [`build-runtime.sh`](packages/daemon/scripts/build-runtime.sh), so the
  package still ships it. What Ghost relies on is its README's host contract:
  the two tool names, `_meta.caller` in, and `_meta.code` out on a failure.
  ghostd spawns one per daemon on first use and serves its tools through
  `ghost mcp serve`
  ([`desktop.ts`](packages/extensions/src/extensions/desktop.ts)): its errors
  reach the model word for word, because they carry the remedy; its text is
  fenced as untrusted. No `ghost-desktop` on PATH means no desktop tools.
- [`packaging`](packaging) owns package assembly, smoke tests, and release
  inputs, not user data or service activation policy. A release is cut locally
  by [`packaging/release/publish.sh`](packaging/release/publish.sh): a
  `vX.Y.Z` tag on `ferdousbhai/ghost` whose GitHub release carries the source
  archive, runtime archive, and `SHA256SUMS` that Omarchy's package hook
  reads. The only install path for owners is Omarchy's package repository.

Protocols implemented by a sidecar have one detailed document:
[`docs/hooks.md`](docs/hooks.md), and ghost-desktop's [README](https://github.com/ferdousbhai/ghost-desktop#readme).

## Harness and lifecycle invariants

- Never start a test daemon against `~/ghosts`, the live port 7717, or the live
  Quickshell bus. Tests use scratch homes and the shell preview's private
  HOME/XDG/dbus/Hyprland.
- One daemon process owns a conversation, and one turn runs in it at a time;
  queued follow-ups into its live turn are the explicit exception.
- Home rename/delete, MCP mutation, and conversation deletion use explicit
  leases and publish only durable state.
- Control files are bounded, validated, atomically replaced, and fail closed on
  links, malformed bytes, identity changes, ambiguous recovery, or incomplete
  fsync.
- Browser/session/process teardown tracks exact captured owners and PIDs: a
  turn's harness is the process group ghostd spawned. No cleanup may kill by
  pattern or remove a broad directory.
- Logs redact secrets and private payloads. Journal identity fields are `GHOST`
  and `CONVERSATION`; other structured fields remain in `MESSAGE`.
- Package install/upgrade gates Ghost on nothing owner-level: no application,
  CLI, or machine skill is required before enabling the services.
- Package removal preserves ghost homes, XDG config/state, owner documents, and any owner-installed machine skill.
- Reversible by default. Disable before delete, Trash instead of `rm`,
  checkpoint before rewrite. Every destructive move has a named way back and a
  way to see it; an audit record of an unrecoverable action is not a substitute
  for undo.
- Self-restart is a systemd handoff. The daemon never restarts itself in
  process, and there is no guardian process and no rebuild-and-restart tool. A
  ghost restarts ghostd by scheduling `systemctl --user restart ghostd.service`
  in a transient `systemd-run --user` unit whose `--description` carries the
  reason, and the same reason is in the commit. See
  [`docs/self-maintenance.md`](docs/self-maintenance.md).

Focused tests beside the implementation are part of these contracts. GitHub
issues track unfinished work and release evidence; this file describes the
desired end state, not the backlog.
