# Contracts

Stable boundaries shared by Ghost's packages and clients. Change these in one
commit with every consumer. Implementation detail belongs in code and tests.

## Product boundary

Ghost is an owner-local Omarchy application: one owner, one machine, any number
of ghosts.

Changes simplify: state what they delete or why nothing can be deleted.
Prefer an installed CLI plus its skill, the harness, or Omarchy over a new
Ghost tool, route, setting, or background loop. New surfaces need a constraint
those cannot meet, documented here. An external component replaces our
machinery rather than adding a parallel backend. Weigh dependencies by
installed size as well as code saved; Omarchy-shipped facilities are available
to reuse. Ask the owner before breaking these rules.

Ghost owns persona, shared history, and harness choice. Harnesses own models,
credentials, permissions, tool loops, retries, and compaction.
`ghostd` owns sessions and state transitions; HUD, CLI, and
`ghost-desktop` are clients or sidecars. The daemon is loopback-only; remote
access is the explicit Tailscale Serve viewer. See [concepts](docs/concepts.md)
for rationale.

Durable state has three scopes:

- **Ghost-private:** character, conversations, settings, and runtime
  sidecars live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, plans, and tasks live in the
  owner's XDG Documents directory, in its project and topic folders, which
  every ghost reads and writes with its runtime's native file and search tools.
- **External:** browser downloads, screenshots, systemd user timers, and
  each harness's credentials, settings, and own session store stay in the
  machine facility that owns them.

The Documents directory is resolved from
`XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`; never a
hard-coded path. It is persistent owner context, not a Ghost-owned store: Ghost
neither indexes it nor injects any part of it, and the system prompt only names
the directory. A ghost searches it on demand, as a task needs
(`ghost help memory`). Recall, an optional product of its own
(`ghost-products`), may index folders the owner selects; its hits are derived,
possibly stale candidates, and the source file is authoritative.
`ghost sessions --semantic QUERY` optionally ranks current conversation titles
and previews through `recall rank`; it does not read transcripts or index notes.
Missing, incompatible, or unresponsive Recall falls back to title/preview text
matching with a warning. Normal session listing never contacts Recall.

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

### Routine inspection and controls

Systemd remains the only schedule store. `ghost routines`
and the HUD and tailnet owner view inspect persistent timers in the configured
systemd user unit directory, using the exact owning ghost prefix. They expose
systemd's calendar/monotonic expressions, next trigger and last service start, enablement,
active state, service command, and latest service result; empty properties are
unknown, not inferred successes. The daemon projects this native state because the HUD and tailnet viewer cannot
inspect the systemd user manager directly; no scheduler or job database is added.
`GET /api/ghosts/:ghost/routines` returns `{ routines, recoveries }`; each routine row has `ghost`,
`slug`, `unit`, `service`, `timerPath`, `servicePath`, `description`, `schedule`,
`nextRun`, `lastRun`, `enabled`, `active`, `command`, `result`, and `serviceActive`
(strings; absent next trigger/last service start are null). Owner-only, including reads because
commands and paths are private. Service command/state/result are unknown and
`servicePath` is empty for a timer targeting a different service. Result stays
unknown until systemd reports a service start. `POST …/routines/:slug/:action`, with action
`pause`, `resume`, or `run`, returns `{ ok: true }` after systemd accepts it.
Pause disables and stops future timer activations, leaving an already running
service alone; resume enables and starts the timer, including systemd's normal
persistent catch-up. Run queues the timer's service without changing enablement
and returns without waiting for the work. A timer targeting anything except its
same-name owned service is inspectable but run is refused. Invalid slugs/actions
are 400, missing timers 404, and systemd failures 503. Ghost lifecycle leases
cover inspection/control so rename/delete waits for accepted operations.
`GET …/routines/:slug/config` returns `{ timer, service, revision }`, the two
UTF-8 unit sources (at most 128 KiB each) and their SHA-256 revision (service is null if
missing). `PUT` accepts the same
shape with both sources nonempty, verifies them with systemd-analyze, checks the revision, stops
the timer (enablement unchanged) while replacing files, reloads systemd, and restores its prior active
state. Only regular, same-name unit pairs without drop-ins may be edited here;
native tools handle other arrangements. Invalid source is 400, stale source is
409. `DELETE …/routines/:slug?revision=…` disables/stops the timer and removes
its pair, leaving any running service alone. Both mutations checkpoint the
previous source under the private `.ghost-routine-recovery/` directory beside
the units and return `{ recovery }`. No mutation discards an earlier checkpoint;
rename/delete discards the ghost's checkpoints with its units.
The effective reloaded target and drop-ins are checked before restarting;
no partial INI parser substitutes for systemd. Source is rechecked after stop,
and failures before writes leave source untouched. Failures roll back changed source and timer state, unless a native save replaced the written
source; a rollback failure or a kept native save names the retained checkpoint. The `recoveries` of `GET …/routines` give each checkpoint's id, slug,
createdAt, reason, and `applicable` (the current source matches its expected revision); an unreadable checkpoint is left out, and an unreadable current
source is not applicable. `POST …/routines/recoveries/:recovery/restore` restores a
checkpoint only against that expected revision, without re-verifying the bytes it
puts back, checkpoints the replaced source,
and leaves the restored timer paused. Restore never silently re-enables work.
CLI `routines config <slug>` prints editable JSON; `routines edit <slug> <file>`
saves it, `remove <slug>` reads/checks the current revision before deletion,
`recoveries` lists checkpoints, and `restore <id>` restores one. The HUD and
phone owner view use the same routes and conflict handling. Changes, controls,
and source reads are serialized per ghost. `GET …/routines/:slug/logs` and
`routines logs <slug>` return the last 100
service journal lines, capped at 64000 characters (`{ text, truncated, sessions }`).
`sessions` lists event conversation IDs named by CLI acceptance receipts in
those lines; clients link them to ordinary conversations. Other services have
no inferred conversation link. These reads are owner-only; journald remains
the log store. Creation remains native file/systemd work; Ghost owns no
scheduler or job history.

### External events

An installed authenticated CLI/service selects events and calls
`ghost event <source> <id> --instructions <owner-instructions> [payload|-]`.
`POST /api/ghosts/:ghost/events` accepts `{ source, id, instructions, payload }`
(strings; source 1–128, id 1–512, instructions 1–16384, payload at most 131072
characters; the rendered prompt must also fit the 200000-character log bound).
This owner-only intake reuses conversations because `ghost say`
has no atomic deduplication; it adds no public listener or provider credential
store. Each source/id hashes to one `event-<sha256>` conversation. Acceptance
logs its prompt before returning `202 { sessionId, duplicate: false }`; the turn
runs independently of the HTTP caller. Repeated matching delivery returns
`200 { sessionId, duplicate: true }`, even after failure or daemon restart.
Reusing an id with changed instructions/data is 409. Different events run in
separate conversations; a repeated busy event is acknowledged without queuing
another turn. Event data is explicitly untrusted and cannot become an owner
`!command`. Source and id remain visible in its prompt/title; ordinary history,
stop, failure reporting, and navigation apply to the event conversation.
There is no automatic replay of an accepted event after a crash: inspect its
conversation and explicitly continue it. Deleting the conversation removes its
deduplication evidence, so a later replay may run again.

Provider catch-up belongs to the installed service/CLI. `ghost help events`
gives a `gh` polling recipe using systemd, an overlapping notification window,
and stable notification/update ids. Fetch or delivery failure fails the native
unit (journald records it); repeating the window retries unaccepted events and
suppresses accepted ones. The owner sets catch-up duration and filters. Slack
requires an existing authenticated Events API/Socket Mode bridge forwarding its
stable event_id; Ghost supplies no Slack app, tokens, subscription, or bridge.
Disconnecting the bridge or pausing/removing its systemd routine stops intake;
reconnecting may replay provider history according to that provider's retention.
No Ghost endpoint needs public exposure. See `docs/events.md`.

### Mobile links and completion delivery

The viewer accepts `?ghost=<name>&session=<id>` links, preserves the selected
conversation in its URL. Transcript responses carry a server-side `readThrough`
timestamp, accepted by `PUT …/read` to cap acknowledgement at the read start;
read timestamps never regress. The viewer marks a displayed owner's reply read only while
the page is visible and focused. Guests never change owner read state. Failed
navigation keeps the requested URL and shows an error instead of silently
opening a different conversation. A completed turn does not imply its result
was read; reopening the right conversation does.

`turn_end` is an opt-in owner command-hook boundary after a whole conversation
turn settles, including failure; cancellation is quiet. It cannot continue or
block a turn. Its bounded payload includes `outcome` (`done`/`error`), `title`,
`excerpt`, and nullable `url`, plus the ordinary hook identity fields. The URL
is the active Tailscale viewer with ghost/session parameters, never a bearer
token. With no handler no provider/network discovery occurs. Commands run
through the existing hook runner with its timeouts/fail-open logging, after
the terminal stream event and outside the conversation's busy state, so a slow
handler never delays the owner's next prompt; failure cannot change the
conversation's outcome.
Owner `!commands` use the same boundary. No notification transport, credential
store, retry queue, or push backend is added: `ghost help notifications` gives
an opt-in curl/ntfy recipe. Removing its `turn_end` handler opts out at the next
boundary. No configured handler means no outbound notification.

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
Deletion is `gio trash` into freedesktop Trash, a rename that refuses rather
than copies; Ghost never recursively removes a home. Machine credentials, owner
documents, screenshots, downloads, and timers are not moved with it.
The lifecycle implementation and crash recovery are in
[`session-host.ts`](packages/daemon/src/session-host.ts).

The checkout a ghost may edit is the clone the daemon was built from
(`GET /api/status` `source.root`), and it is the same for every ghost on the
machine: one daemon powers them all, so a self-edit powers all of them after a
build and restart. A packaged install has no checkout. No per-ghost setting
names one; the checkout's own rules and MCP never enter a session, and of its
skills only the shipped `skills/` do (see "Ghost-home resources").
`settings.yml` names no cwd: every conversation runs in its own directory.

### Character and notes

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body, bounded by
`MAX_CHARACTER_BODY_LENGTH` in [`home.ts`](packages/daemon/src/home.ts),
is the persona. A seeded or blank character marks onboarding; the ghost shows
the owner a draft and waits for confirmation before replacing it.

There is no ghost-private memory store. A ghost's notes — owner facts,
decisions, tasks, and its own reflections — are Markdown files under the
owner's Documents directory itself, written and
read with the harness's native file tools, shared by every ghost and readable
by the owner ([Product boundary](#product-boundary) says what may index it).
Cleanup (merging, rewriting, and trashing stale notes) is an ordinary turn the
owner asks for or schedules as a timer, following `ghost help memory`; Ghost
runs no memory maintenance of its own.

### Ghost-home resources

`character.md` is the one persona file, the owner's instructions for this
ghost included; there is no ghost-home `AGENTS.md`. Each conversation directory
gets `.claude/skills` and `.agents/skills`, where harnesses look for project
skills, holding one link per skill: the skills Ghost ships (the repository's
`skills/`, installed at `/usr/lib/ghost/skills`; a checkout links its own), then
the ghost's `skills/`, which wins on a shared name. Links are refreshed every
turn, so an upgrade or a removed skill takes effect on the next one. Ghost ships
only skills no product ships itself: `ghost-products` indexes the recommended
products, each of which installs its own skill. `web-browser` adds the
owner-wide session and task-tab locking recipe to agent-browser's own guide.
Machine skills are whatever
each harness discovers itself. `mcp.json`
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
records, `harness` records naming the harness that took over and the
session id it reported, per-run `resources` records, and historical `handoff` records. A torn last line is skipped. ghostd is the log's
only writer and only appends; an in-place edit by anything else is unsupported.
The log is the history
every client reads; each harness's own transcript is its resume state, never
imported as conversation history. The display-only session metadata inspection
below is the one exception to reading it. A conversation is listed once a message lands or the owner
names it; each row carries `preview`, the first owner text, and `title`,
the owner's name for it or else one extracted from that text without a model
(`derivedTitle`), null when nothing substantive is left. Pins and read
timestamps are bounded sidecars beside the directories. Deletion moves the
directory to recoverable Trash in one rename; there is no fork.

### Machine-owned artifacts

- Desktop screenshots follow ghost-desktop's host contract. Bash browser
  screenshots use the owner's requested destination or XDG Pictures directory.
  Ghost keeps no browser screenshot retention manager.
- Browser downloads belong to agent-browser and Chromium; the Bash caller
  chooses the owner's requested destination or XDG Downloads directory.
- Scheduled work is a systemd user `.timer`/`.service` pair named
  `ghost-timer-v1-<name-length>-<ghost>-<slug>`. Ghost prompts author persistent
  units; rename/delete retire units owned by that prefix. See
  [`schedules.ts`](packages/daemon/src/schedules.ts).
- Harness credentials are the harness's own, signed in by the owner with that
  harness; a turn, and a hook's completion, spends the account Omarchy marks
  active for claude, codex, and grok (`omarchy-agent-account-home`). An MCP server's headers or env are
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
| Screenshots in the XDG Pictures directory | survive | not moved or renamed | not removed | unchanged | unchanged | preserved |
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
relies on: the other-harnesses policy sends a task to an agent run in its
project (`ghost delegate`, which runs an installed harness) only when it
needs that project's instructions, settings, or MCP servers; the owner-context
policy names the Documents directory as where finished work, notes, and the
board live. Owner documents are read only when
relevant, with the harness's own file and search tools, never injected
automatically. The prompt is rendered before every turn, so a character the
ghost rewrote is who it is on the next one.

### Harnesses

A turn is one headless run of an agent CLI, a row of
[`harness-table.ts`](packages/daemon/src/harness-table.ts): how to launch it
non-interactively with permissions pre-approved, how to resume, how it takes
MCP servers, and a parser from its JSON output to text, reasoning, tool
start/end, session, model, and error events. Rows exist for claude, codex, grok,
copilot, opencode, pi, omp, agy, cursor-agent, crush, and muse; their parsers
are tested against output each CLI really printed. That table is the one
per-harness adapter, and a row is launch flags plus a parser, never a chat
loop. The one deliberate exception: display-only facts absent from stdout are read
after the pass from the session record the harness wrote, found by a session id
reported by this pass (`inspectSession`: Codex's rollout file, OpenCode's
database). This reads the model/provider/effort, and Codex's own rendered
`world_state.state.host_skills.body` catalog. Codex inventory is accepted only
when the latest `turn_context` is timestamped at or after this pass started;
otherwise a failed resume must not borrow an older run's inventory. Catalog
names are parsed from its `### Available skills` section, not reconstructed
from skill directories; missing or malformed catalogs remain unknown. After
finding the latest model record, catalog lookup reads at most 8 MiB backwards;
a catalog beyond that display-only read budget remains unknown. Nothing
from that inspection enters handoff context. The owner should always be able to see what answered. Every successful pass records and streams a `resources` snapshot with run id,
harness, completion time, harness-reported name lists, and names supplied by
Ghost. Unknown inventories replace older evidence; failed attempts leave the
last successful snapshot. Only names cross the wire. Reported categories are
skills, extensions/plugins, connected MCP servers, and tools where native
output provides evidence. Ghost-supplied
instructions and forwarded MCP names are separate from reported connections.
No scan of installed resources or model self-report substitutes for evidence.
Skill availability does not prove its body entered context. Version coverage
and limitations are in [`docs/run-resources.md`](docs/run-resources.md).

Resources never become transcript messages, prompt context, message counts,
unread state, or activity timestamps. `GET …/transcript` includes the latest
successful snapshot as `resources` independently of pagination, or `null`.
The HUD harness menu and tailnet viewer expose a read-only Resources inspector;
`ghost show --resources` prints it explicitly. Ordinary chat and CLI output
remain quiet. Historical records are read without rewriting logs; legacy snapshots are
associated using their run-start and reply timestamps, and ambiguous evidence
is omitted. The MCP
navbar editor manages only the ghost's additional configured servers; it is
not a run inventory.
Everything else — model, auth, tools, permissions, compaction, retries —
is the harness's own, configured by the owner exactly as when they run it.

The harness runs in the conversation directory with the conversation's
identity (`GHOST`, `GHOST_SESSION`) in its environment. Ghost writes the
persona there as `AGENTS.md`, with `CLAUDE.md` and `GEMINI.md` linking to it;
grok, which reads none of them, gets it as `--rules`. Because the directory is
the conversation's own, a harness's "continue the most recent session here" is
the conversation's resume; opencode and muse, whose continue is not
cwd-scoped, are resumed by the session id they reported. Each turn also
receives `ghost-desktop` as its `ghost` MCP server, when installed (the
desktop tools), and the ghost's enabled `mcp.json` rows,
`${VAR}`-expanded and with relative stdio `cwd`s resolved against the ghost
home, in that harness's own dialect: a `--mcp-config` file, `-c
mcp_servers.*` overrides, `OPENCODE_CONFIG_CONTENT`, or a project config file
in the conversation directory. A row is a stdio `command`/`args`/`env`/`cwd`
or a remote `url`/`headers`, plus `enabled` and the `envPolicy`/`headerPolicy`
expansion switches; any other field makes it invalid, since no harness dialect
carries it. The current pi row does not forward Ghost's MCP servers; Pi 1.2
itself supports MCP configured by the owner.

Which harness answers is decided per turn
([`session-host.ts`](packages/daemon/src/session-host.ts)): the one already
carrying the conversation (or the one the owner or ghost switched it to),
then the ghost's `settings.yml` `harness`, then
Omarchy's default agent, then every other harness Omarchy reports installed
(`ghost harnesses`). A harness that fails
before producing anything (not signed in, out of quota, not installed) hands
the prompt to the next; one that fails after answering ends the turn in an
error. A harness new to a conversation receives the newest
`HANDOFF_CONTEXT_CHARS` of the log as `<conversation-so-far>`; a continuing one
receives the owner's `!` commands it has not seen as `<owner-commands>`. The
owner's `!command` runs in the owner home with the conversation's identity
and is logged; `!!command` is logged but never handed on. A message that
opens with an attached photo, `![image](…)`, is a prompt, not a command.

A turn takes no input mid-run: text queued while it runs (`/queue`, `ghost say
--follow-up`) runs as the next pass in the same stream. A
queued follow-up outranks a stop hook: no `session_stop` is asked while one
waits, and one sent while the hook runs replaces its continuation.
A turn outlives its client: a dropped stream stops only the listening, and
`POST /sessions/:id/stop` or daemon shutdown cancels it; an internal runtime
or replay-storage failure ends it in error.
Aborting a turn signals the harness's process group, SIGTERM then SIGKILL,
and nothing else. Reading images and choosing the model are the harness's;
Ghost only stores an attached image where the harness can open it.

### Background work and hooks

There is no `ask` tool: a question to the owner is an ordinary reply.

Background work is shell work: a ghost detaches a command
(`setsid -f`), logs to a file, and ends it with `ghost say --follow-up`, which
queues after a live turn or, when the conversation is idle, starts its next
turn. `GHOST` and `GHOST_SESSION` are in the Bash environment so
the CLI addresses the right conversation without flags. Ghost keeps no job
table, no jobs API, no jobs strip, and cannot cancel what it did not start;
the policy (`BACKGROUND_WORK_POLICY` in
[`prompt-policy.ts`](packages/daemon/src/prompt-policy.ts)) points at the recipe,
`ghost help background`.

There is no Ghost-owned delegation system: no worker scopes, `/tasks` API, or
job control. A ghost that wants a specialist runs the owner's installed `pi`,
`codex`, `omp`, or `claude -p` from its own Bash as `cd <dir> && ghost delegate
<harness> -- <args>` (`HARNESS_LIMITS_POLICY` in
[`prompt-policy.ts`](packages/daemon/src/prompt-policy.ts)); that harness runs
with the owner's own settings for it — its full tool set, project discovery,
auth, and session semantics.
`ghost delegate` refuses an uninstalled harness (exit 5); otherwise it runs
in the foreground in the caller's cwd and process group, with the caller's
environment and stdin, its stdout and stderr streamed through unchanged; SIGINT
and SIGTERM are forwarded to it, and once it exits the verb stops reading when
its pipes have been idle for 100ms, so a descendant holding them cannot hang
the call. The verb exits with the harness's status (128 plus the signal number
when a signal ended it, 127 when it could not start).

A delegated harness gets the same `ghost` server: `ghost delegate` adds
`ghost-desktop` to the two harnesses whose flags for it are known, unless it
is not installed or the run already names an MCP config: `claude` gets
`--allowedTools mcp__ghost --mcp-config <ghost server>` after its own
arguments (both flags take lists, and a `--` in them leaves the run alone),
`codex` gets a `-c mcp_servers.ghost.command` override ahead of them. That table is a deliberate exception to
the harness table's being the one adapter: two flags per harness, and it
replaces a recipe every model had to copy exactly. Other harnesses load it
themselves (an omp `mcp.json` row, or Pi's native MCP settings).

Every attempt, refused or run, appends one JSON line to
`$XDG_STATE_HOME/ghost/handoffs.jsonl` (falling back to `~/.local/state`; the
file is 0600, and past 1 MiB it moves to `handoffs.jsonl.1`, replacing the
previous one): `{v: 1, at, ghost, session, harness, pick, cwd, eligible, windows,
status, outcome}`, where `ghost` and `session` come from `$GHOST` and `$GHOST_SESSION`
(or `null`), `pick` is `"owner"` when `--owner-named` says the owner named the
harness or no `$GHOST` is set (the owner ran the verb), else `"ghost"`, `eligible` lists the harnesses eligible at the check, `windows` is
this harness's last reported windows then, `status` is Omarchy's note when it could not
measure this harness (an unmeasured harness is eligible, and this shows the
usage was unmeasured) or `null`, and `outcome` is `{refused}` with the reason,
or `{exit, signal, durationMs, limit}`, `durationMs` the harness's own run
time, `limit` being `classifyLimitMessage`'s kind for the last 8 KiB of output
of a run that did not exit 0, else `null`. No prompt text or arguments are
kept. A receipt that cannot be written is a warning on stderr, never a changed
exit status. The log is the evidence for judging routing; nothing in Ghost
reads it back. The owner's summary of it is `bun scripts/handoff-report.ts`
from a checkout, outside the shipped package: attempts, refusals by kind, exit
outcomes, unmeasured checks, and limits hit, per harness.

Ghost hooks are `before_prompt`, `session_stop`, and `turn_end`, run by ghostd
above whatever hooks the harness has of its own.
The first two are awaited around each pass; `turn_end` runs detached after the
terminal frame, bounded by its own timeout (a daemon stop does not wait for it).
Their JSON protocol, failure behavior, and settings are defined in
[`docs/hooks.md`](docs/hooks.md). A stop hook owns its continuation policy;
Ghost sets `stop_hook_active` on hook continuation passes and does not impose
a host bound; `owner_prompt` and `turn_id` identify one owner request across
its continuations.
`ghostd hook-complete` gives a hook one completion from the ghost's
preferred harness ([`hook-complete.ts`](packages/daemon/src/hook-complete.ts)).
Ghost starts no automatic idle handoff or next-work turns. Only owner requests,
schedules, and explicit owner command hooks initiate work. Legacy `builtin`
settings in `hooks.json` are ignored; command hooks remain active. Historical
`handoff` and `auto` log entries remain readable.

## Daemon HTTP API

`ghostd` is the only session owner. All `/api/*` routes require the bearer token
from Ghost's mode-0600 XDG-state token file, except explicitly public
viewer assets, and authenticated tailnet requests. Loopback CORS allows only the exact
HUD/client methods and headers. Errors are
`{ "error": { "code": string, "message": string } }` with a meaningful HTTP
status. Request bodies and control files are bounded before allocation.

Tailnet identity is accepted only from Tailscale Serve's verified local proxy
boundary. The configured owner has full access; admitted guests are read-only,
and are refused the routes marked owner-only, which show file paths, hook
commands, or MCP credentials.
Remote access never broadens a ghost's local tool authority.

Route parsing, validation, status codes, and reverse states are executable in
[`server.ts`](packages/daemon/src/server.ts) and
[`server.test.ts`](packages/daemon/test/server.test.ts). Stable route families:

Rows beginning `/sessions/` are relative to `/api/ghosts/:name`.

| Route | Contract |
|---|---|
| `GET\|PUT /api/hooks/config` | Owner-only. Read or atomically replace the admitted `hooks.json`. |
| `GET /api/ghosts/:ghost/routines`, `POST /api/ghosts/:ghost/routines/:slug/:action` | Owner-only [routine inspection and controls](#routine-inspection-and-controls). |
| `POST /api/ghosts/:ghost/events` | Owner-only [external event intake](#external-events); the GET event stream remains conversation invalidations. |
| `GET /api/board` | The owner's `board.md`, parsed to columns and cards; bounded; readable by tailnet guests; never written through the API. |
| `GET /api/status` | Owner-only `{ version, source: { commit, root } }`. `root` is the git root of the running entry script, or `null` for the packaged install; a guest is refused the row rather than shown a filesystem path. Updates belong to Omarchy's package manager; Ghost neither polls releases nor applies updates. |
| `GET\|POST /api/ghosts` | List or create ghosts. |
| `PUT /api/ghosts/:name/name` | Rename a ghost and its whole home. |
| `DELETE /api/ghosts/:name?confirm=:name` | Move a ghost home to recoverable Trash. |
| `GET\|PUT /api/ghosts/:name/character` | Read or atomically replace the persona file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `GET\|POST\|PUT\|DELETE /api/ghosts/:name/mcp…` | Owner-only. The ghost's `mcp.json` servers as stored, credentials included, and their mutation and enablement. A server added through this API starts disabled unless its row says `enabled: true`; the next turn hands enabled rows to the harness, which connects them. |
| `GET\|PUT /api/ghosts/:name/harness` | `{ harnesses: [{id, effort, usage}], ghostDefault, omarchyDefault }`: the installed agents Ghost has a row for, with the effort its launch asks for (null where the owner's setting stands) and Omarchy's usage, the ghost's preferred agent (`settings.yml` `harness`, null for automatic), and Omarchy's default. `PUT { harness: id \| null }` sets or clears the preference, keeping the file's other keys; an id with no row is `400 unknown_harness`. |
| `PUT /sessions/:id/harness` | `{ harness: id }` → `{ id, harness }`: the conversation's next turn runs on that agent, handed the conversation so far; a conversation with no message yet may be pointed first. A running turn refuses it with `409 session_busy`. An uninstalled agent is refused with `409 harness_not_installed`. |
| `POST /api/ghosts/:name/messages` | `{ prompt, sessionId? }` → one turn as the turn wire below; a missing `sessionId` is the conversation `default`. |
| `GET /sessions/:id/stream?turn=:turn&from=:n` | The rest of a cut turn stream (turn wire below), from its event `n` on. A turn stays resumable until a minute after it ends; after that, or for a turn this daemon never ran, `404 turn_not_found`, and the client reads the transcript instead. |
| `GET /api/ghosts/:name/events` | Conversation invalidation SSE; responses close after about 1 MB or socket backpressure. Clients reconnect and refetch state to cover missed invalidations. |
| `GET /api/ghosts/:name/sessions` | Conversation rows `{ id, title, preview, harness, model, provider, effort, updatedAt, messageCount, pinned, unread, running }`, pinned first, then newest, for each conversation with a message (an owner `!command` the transcript shows counts), a title, or a run in progress; `running` marks a turn or `!command` in progress, whichever client started it, and a turn's start, each later pass, and its end announce on `/events`; `model`, `provider`, and `effort` are what `harness` last ran on, as far as it said (null otherwise); `updatedAt` is the last owner or ghost entry, which a `handoff` is not. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `GET /sessions/:id/transcript` | Paged renderable history projected from the conversation log, `{ id, messages, total, truncated, resources, readThrough }`; an owner or hook message's optional `contentTruncated: true` marks text cut to the log bound, an assistant message's `errorMessage` a failed turn; Historical `handoff` and `auto` messages remain readable. An owner `!command` reads as the owner's `!command` followed by its output. |
| `POST /sessions/:id/attachments` | An image body (PNG, JPEG, GIF, or WebP by its bytes, at most 20 MiB), or from the machine-local token a JSON `{ path }` naming a local image to copy → `201 { path }`, `attachments/<file>` relative to the conversation directory, which need not hold a turn yet. A message names it on its own line as `![image](attachments/<file>)`; the harness opens it with its own tools and clients show it as a picture. |
| `GET /sessions/:id/attachments/:file` | The stored image. |
| `POST /sessions/:id/stop` | Abort the conversation's running turn or `!command`; its stream ends `aborted`. An idle conversation answers `409 session_not_streaming`. |
| `GET\|POST /sessions/:id/queue` | Inspect (`{ streaming, followUp }`) or enqueue `{ text }` into a live turn; it runs as the next pass of the same stream, even after a pass that failed. A stop ends the turn without running it; the HUD hands its own queued text back to the composer. An idle conversation answers `409 session_not_streaming`; `ghost say --follow-up` then posts the text as a new turn instead. A running `!command` answers `409 session_busy`. |
| `DELETE /sessions/:id` | Move the conversation directory to Trash. |
| `GET /api/remote/whoami` | `{ role }`: the caller's effective role, `owner` or `guest`. |
| `GET\|POST /api/remote` and `GET /api/remote/qr.svg` | Tailscale Serve status/control and active URL QR. |
| `GET /manifest.webmanifest` | Public viewer manifest. |

There are intentionally no `/plan`, `/todo`, `/live`, or `/collab` session
routes: Ghost ships no live-voice controller and no collaboration host, and
remote access is the tailnet viewer alone.

### Turn wire

The event union is the contract; clients must ignore unknown future event
types. See [`turn-events.ts`](packages/daemon/src/turn-events.ts). A turn
emits `start`, then ordered `harness` (a pass starting on that harness, again
on each fallback), `resources` (a successful pass's final resource snapshot, display-only), `text_*`, `thinking` (the harness's reasoning, as
far as it shows it; never logged), `tool_execution_*`, `queue` (the follow-ups still
waiting, on every change), `owner_message` (a queued follow-up starting its pass), `hook_start`/`hook_end` (a `before_prompt` or `session_stop` command hook
running, by its `name` and `event`; clients show a `session_stop` one as a settled turn), and `session_stop_continued` events, and exactly one
terminal `done` or `error`. A quota refusal is a typed `limit_reached`
event (harness, kind) sent before that `error`; the classifier is
`classifyLimitMessage`. Tool events carry the call id; a start names the
tool and the directory it runs in, an update carries a bounded output
summary, and an end names the tool and carries `isError` and the summary. An owner `!command` is
one `bash` tool card, then `done`.

A turn response is cut after about 1 MB of events so no client has to hold
one ever-growing body: its last frame is then `resume` `{ turn, from }`, not a
terminal, and the turn runs on. The client continues by opening
`GET /sessions/:id/stream?turn=…&from=…`, which is itself cut the same way;
counting `start` as event 0, the events across all responses are each sent
once, in order, ending in the one terminal. Large turn replay buffers spill to private,
unlinked files under `$XDG_CACHE_HOME/ghost` (default `~/.cache/ghost`), rather
than the usually memory-backed `/tmp`. They are released after the resume grace
period (once attached readers finish) or server shutdown, and are not history.

### `ghost` CLI

The terminal client never edits a ghost home; every command that changes ghost
state goes through the daemon. Its command catalog is defined in
[`cli/main.ts`](packages/daemon/src/cli/main.ts). Every daemon capability the
HUD reaches is a named verb there (ghost list, rename, character, sessions
and their title/pin/read/delete/stop, the agent a ghost prefers (`ghost harness`)
and a conversation runs on (`ghost switch`), MCP, hooks, remote, and
status), so a
ghost can drive and verify itself from Bash without raw HTTP. `ghost help
<topic>` prints the recipes the system prompt only points at (`timers`,
`self`, `harnesses`, `background`, `memory`) and ones it does not
(`dictation`, `events`, `notifications`;
[`help-topics.ts`](packages/daemon/src/help-topics.ts)),
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
is `{id, usage}`, and `usage` is `null` without a record,
else `{updatedAt, stale, status, windows}` with each window `{label, percent,
resetsAt}`, `percent` a 0–1 fraction used. All installed harnesses are eligible
regardless of usage.
A record's `ready` only says Omarchy has data to show, so it
decides nothing. A window whose reset has
passed is dropped. `stale` marks a record older than 15 minutes; the verb never
refreshes one, and `refresh` is the Omarchy command that does. `-q` prints the
eligible ids, one per line. It keeps no state and throttles nothing. Addressing is
`-g`, then `$GHOST`, then the `ghost use` default, then the sole ghost, and
`-s`, then
`$GHOST_SESSION`, then the latest conversation; a ghost's own shell, and the
owner's `!` commands in a conversation, carry both variables. Signing in is
the harness's own (`claude`, `codex login`, …); Ghost has no login or model
commands. There are no plan or todo commands.

## Limits and credentials

Ghost has no model, provider, or credential of its own: each harness reads its
sign-in from its own configuration exactly as when the owner runs it by hand,
and its environment is the daemon's own, unscrubbed. Credential values never
enter logs; the only API response that carries them is the owner's own MCP
configuration.

Ghosts run unthrottled. Harness limits surface as typed errors, and the
harness's own retry and fallback behavior applies; Ghost's one contribution is
the per-turn order of installed harnesses above. Omarchy usage records are
informational only. Ghost adds no turn, hosted-session, concurrency, or spend cap. The
one deliberate exception is the
desktop lease (ghost-desktop's [`lease.ts`](https://github.com/ferdousbhai/ghost-desktop/blob/master/src/lease.ts)): there is one
pointer and one focus, so every `desktop_act` call claims the desktop for its
caller, and another caller's call fails `busy` naming the holder until the
holder has been idle 15 s. The lease is a file under
`$XDG_RUNTIME_DIR/ghost-desktop/`, shared by every `ghost-desktop` process of
the user, so two turns and a separately launched MCP client (Claude Code)
take turns too. A caller is one `ghost-desktop` process, named after its
client, so each harness pass is its own caller.
`desktop_look` never claims and reports a foreign holder as `heldBy`.

## Package boundaries

**ghost-core** is `packages/daemon`.
**ghost-omarchy** is `packages/shell` (`@ghost/omarchy`) plus the separate
`ghost-desktop` repository. Core never imports the Omarchy side;
`scripts/check-core-boundary.sh` proves this during lint. Their seams are the
authenticated HTTP/SSE API and desktop MCP stdio.

The Arch install has two packages built from the same release: `ghost-runtime`
owns the daemon, CLI, `ghost-desktop`, user unit, and runtime docs/licenses;
`ghost` owns the HUD, desktop launcher, icons, and shell snippets and depends on
that exact runtime version. The checkout variants are `ghost-runtime-dev` and
`ghost-dev`. Installing only the runtime keeps desktop/browser automation in the
existing graphical session without requiring Quickshell or installing Ghost UI.
An app supplies its own UI over the same authenticated HTTP/SSE API. Adding or
removing the UI neither stops the runtime nor changes ghost homes; removing the
runtime preserves owner data.

- [`packages/daemon`](packages/daemon/src/main.ts) owns ghost homes and the
  persona prompt, configuration, authentication, conversations, the harness table, MCP, hooks, lifecycle,
  HTTP, and the `ghost` CLI. Bun is the production runtime.
- [`packages/shell`](packages/shell/qml/manifest.json) is the `@ghost/omarchy`
  package: an omarchy-shell plugin, id `ferdousbhai.ghost`, declaring `service`
  (the daemon connection and
  the notifications a shut window would swallow), `panel` (the chat window), and
  `bar-widget` (the state dot) kinds. It runs inside Omarchy's own shell
  process, so Ghost ships no shell, unit, or tray helper of its own, and its QML
  imports are relative paths: inside the host, `qs.` resolves to Omarchy's shell
  root. The bar widget fills the injected `bar.barSize` across the bar and
  the host's 27px icon slot along it. Hover text uses the
  host's `bar.showTooltip`/`hideTooltip` API and `tooltipHovered` lifecycle;
  Omarchy owns its theme, sizing, and placement. The widget exposes
  `triggerPress(button)` so the host's drag-aware click forwarding toggles the
  panel on left click through the injected `bar.shell` facade. The package installs it
  to `/usr/share/ghost/plugin`; the per-user symlink into
  `~/.config/omarchy/plugins/` belongs to the install script, which waits for
  shell discovery before enabling the plugin. Setup ends with `ghost new <name>`; harness sign-in is external.
  The plugin is distributed only by the `ghost` package, never as a
  `omarchy plugin add` git checkout: the window and the daemon are one product
  and must be the same version, and a second channel cannot hold that lock.
  Desktop toasts belong to the shell service. Optional mobile delivery uses the
owner's `turn_end` command hook. Completed turns,
  and terminal failures notify unless their conversation is
  being viewed in the focused, visible chat panel. Only that chat marks replies
  read. Focus is the HUD's own Qt window state, not a compositor title cache.
  Cancellation is quiet. Toasts use
  the conversation title and a reply/error excerpt, replace live toasts
  per ghost and conversation using the notification server’s IDs, and open that
  conversation through a summon payload
  `{ "ghost": "name", "sessionId": "id", "section": "chat" }`, carried in
  Omarchy’s `omarchy-exec-argv` notification hint.
  It talks only to authenticated HTTP/SSE and never edits daemon-validated ghost
  state (character, control files) directly; the one deliberate
  exception is the workbench file editor, which writes ordinary files at the
  owner's explicit direction. A conflict or failed save blocks closing,
  switching files, and opening the external editor until resolved.
  Dictation is Omarchy's Voxtype: the shell reads
  `$XDG_RUNTIME_DIR/voxtype/state`, focuses the composer, then runs
  `voxtype record start` when idle or `stop` when recording; the mic is
  disabled while transcribing. Esc in the composer or its cancel control runs
  `voxtype record cancel` while recording or transcribing. A command that
  exits nonzero, crashes, or never starts shows as status text above the
  field, whatever the draft or state, until the next command; Voxtype reports
  no failed transcription, so the HUD shows none. Ghost ships no speech stack
  of its own.
- [ghost-desktop](https://github.com/ferdousbhai/ghost-desktop) is Hyprland computer use as a stdio MCP server
  with two tools, `desktop_look` (never changes the desktop) and `desktop_act`
  (ordered steps); any MCP client can run it. It is its own repository with
  its own version, pinned by tag in the root `package.json` and bundled into
  the runtime as `ghost-desktop` by
  [`build-runtime.sh`](packages/daemon/scripts/build-runtime.sh), so the
  package still ships it. What Ghost relies on is its README's host contract:
  the two tool names, its untrusted-content fence, and errors written for the
  model. Each harness pass runs its own, as the turn's `ghost` MCP server
  (`$GHOST_DESKTOP`, else `ghost-desktop` from PATH); ghostd never calls it.
  No `ghost-desktop` means no desktop tools.
- [`packaging`](packaging) owns package assembly, smoke tests, and release
  inputs, not user data or service activation policy. Upgrade guidance
  refreshes enablement and explicitly restarts an active daemon to load its bundle. A release is cut locally
  by [`packaging/release/publish.sh`](packaging/release/publish.sh): a
  `vX.Y.Z` tag on `ferdousbhai/ghost` whose GitHub release carries the source
  archive, runtime archive, and `SHA256SUMS`; Omarchy's sync reads GitHub's
  asset digests. The only install path for owners is Omarchy's package repository.

Protocols implemented by a sidecar have one detailed document:
[`docs/hooks.md`](docs/hooks.md), and ghost-desktop's [README](https://github.com/ferdousbhai/ghost-desktop#readme).

Browser automation belongs to the installed `agent-browser` CLI and its skill,
invoked through the harness's Bash tool. Ghost exposes no browser MCP tool,
relay, pairing API, or browser lifecycle manager. One owner-wide session
(`owner`) shares the signed-in Chromium over loopback CDP. Conversations use
separate tabs; cooperating callers lock tab selection and each operation with
one owner-wide `flock`. Tab selection invalidates snapshot refs; separate
operations use semantic or CSS selectors. Ref-based sequences hold the lock
from selection and snapshot through action without reselecting. Tabs and CLI
state survive Ghost restarts, rename and deletion; explicitly close a task's tabs when finished, never the owner's
browser. Setup and recovery are in `skills/web-browser/SKILL.md`.

## Harness and lifecycle invariants

- Never start a test daemon against `~/ghosts`, the live port 7717, or the live
  Quickshell bus. Canary/smoke daemons isolate Ghost config and owner hooks
  and use a fake or disabled desktop. Tests use scratch homes and the shell preview's private
  HOME/XDG/dbus/Hyprland.
- One daemon process owns a conversation, and one turn runs in it at a time;
  queued follow-ups into its live turn are the explicit exception.
- Home rename/delete, MCP mutation, and conversation deletion use explicit
  leases and publish only durable state.
- Control files are bounded (1 MiB), validated, and replaced atomically by
  rename; malformed bytes are refused, and a symlinked file is followed like
  any other. Every process involved runs as the owner, so ghostd defends
  against corruption, not against the owner's own processes.
- Session/process teardown tracks exact captured owners and PIDs: a
  turn's harness is the process group ghostd spawned. Settled passes close
  inherited pipes and emit no late events; cancellation kills surviving members
  of that group even after its leader exits. Normal completion leaves detached
  background jobs alone. No cleanup may kill by
  pattern or remove a broad directory.
- Logs redact secrets and private payloads. A log line's structured fields,
  ghost and conversation included, are JSON in its journal `MESSAGE`.
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
