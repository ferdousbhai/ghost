# Contracts

Stable boundaries shared by Ghost's packages and clients. Change these in one
commit with every consumer. Implementation detail belongs in code and tests.

What belongs here is what another package, a third-party client, or the
owner's own configuration relies on. How a package behaves inside itself
belongs in its README.

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
credentials, permissions, tool loops, retries, and compaction. The one
exception is the [local model](#local-model): a model on this machine that
ghostd runs, and loops over, itself.
`ghostd` owns sessions and state transitions; the HUD and CLI are clients. The daemon binds `127.0.0.1` only (no setting moves it; a `host` key an earlier config carries is ignored, like any key Ghost does not read) and serves no web page; remote
access is the summonghost.com app over an explicit Tailscale Serve address. The
app is a static page, not a backend: it has no server, accounts, or storage;
the browser calls each machine's Serve address directly, admitted by Tailscale
identity. Whoever controls summonghost.com's code can therefore act as a
visiting owner on that owner's tailnet; `remote.apps: []` opts out, leaving no
remote client at all. See [concepts](docs/concepts.md) for rationale.

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
(`ghost help products`), may index folders the owner selects; its hits are derived,
possibly stale candidates, and the source file is authoritative; `ghost help
memory` points a ghost at it for things whose words or place are unknown.

Document content is unaffected by creating, renaming, deleting, or
uninstalling a ghost.

There is no Ghost plan mode, todo store, or plan/todo API. Harness native
planning may exist, but durable owner-visible plans and tasks belong in the
owner's documents. Background work is the shell's: Ghost keeps no job table
(see "Background work and hooks").

### Routine inspection and controls

Systemd remains the only schedule store. `ghost routines`
and the HUD inspect persistent timers in the configured
systemd user unit directory, using the exact owning ghost prefix. They expose
systemd's calendar/monotonic expressions, next trigger and last service start, enablement,
active state, service command, and latest service result; empty properties are
unknown, not inferred successes. The daemon projects this native state because the HUD cannot
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
`ghost routines` use the same routes and conflict handling. Changes, controls,
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
`ghost event <source> <id> --instructions <owner-instructions> [--thread <key>] [payload|-]`.
`POST /api/ghosts/:ghost/events` accepts `{ source, id, thread?, instructions, payload }`
(strings; source 1–128, id and thread 1–512, instructions 1–16384, payload at most 131072
characters; the rendered prompt must also fit the 200000-character log bound).
This intake reuses conversations because `ghost say`
has no atomic deduplication; it adds no public listener or provider credential
store. Each source/id hashes to one `event-<sha256>` conversation; with a
`thread`, source/thread hashes to the one its events share, so a ghost sees what
it said about that subject before. An event whose thread is running a turn takes
its own source/id conversation instead, so nothing waits. Acceptance
logs its prompt before returning `202 { sessionId, duplicate: false }`; the turn
runs independently of the HTTP caller. Repeated matching delivery returns
`200 { sessionId, duplicate: true }`, even after failure or daemon restart.
Reusing an id with changed instructions/data is 409. Different events without
a shared thread run in separate conversations; a repeated busy event is
acknowledged without queuing another turn. Event data is explicitly untrusted
and cannot become an owner `!command`. Source and id remain visible in its
prompt. The title, unless the owner set one, is the first sentence of the last
text of the latest event's reply, or `<source>: <id>` until one arrives, derived
on read with no model. Ordinary history, stop, failure reporting, and navigation
apply to the event conversation.
An event turn that fails because its model could not be reached (DNS, a
refused, reset, or timed-out connection: `isUnreachableMessage` in
`turn-events.ts`) runs again with the same prompt after 1, 2, 4, 8, 16, 32,
60, and 60 minutes, until a run ends any other way; a rerun is skipped once
the owner or a later event has added to the conversation (a message or
`!command`) or while a turn runs there. The waits are in memory. Instead, each
daemon start reruns, within 24 hours of its acceptance, an event whose prompt,
the conversation's latest, the last run left
unfinished: no reply (a crash), a reply that could not reach its model, or one
a daemon stop cut off (the assistant log entry's `interrupted`; once only, so
a turn that restarts the daemon cannot loop). The owner's stop is not rerun.
Meanwhile the conversation is an unread finding whose reply is the failure;
the rerun's answer follows it in the transcript.
There is no other automatic replay of an accepted event: inspect its
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

### Machine watch

Ghost adds no machine-monitoring code: a ghost reads strain with installed
tools (`omarchy system stats`, batch `systemd-cgtop`, `/proc/pressure`,
`sensors -j`, `df`), and `ghost help machine` gives the opt-in watch, a minutely
routine with slug `machine-watch` running a Bash script the ghost saves. It wakes
the ghost while the machine heats up, with fans above half speed for three
checks in a row, and near harm, never for ordinary load: a kernel thermal warning,
a temperature within 5 °C of its sensor's critical limit or a fan at 95% of its
maximum, available memory
under 5%, swap over 85% used (systemd-oomd acts at 90%), or memory full-stall
avg60 of 20% or more, or `/` or `$HOME` 97% full. Each condition is a `ghost
event machine <kind>-<YYYYMMDDHH> --thread <kind>` (heat, memory, disk), so at
most one per kind an hour, each kind one conversation; `heating-<YYYYMMDDHH>`
shares the heat thread, so a later heat event still arrives, and repeats each
quarter hour (`-<0-3>`) while load is at least half the cores, so idle heat such
as fast charging stays hourly; exit 6 (an id already accepted with older data) counts as delivered.
The payload is the tools' own output, naming the busiest units and processes and the agents behind them, from the
environment a detached job keeps from its agent, including processes above half
a core earlier in this heating, since a burst may exit before the ghost looks.
One ghost per machine installs it, only when the owner asks; the routines view
pauses, inspects, and removes it. The recipe has the ghost fix only its own or
plainly broken units, least drastic first (CPU weight, freeze, stop), instruct
an agent behind the load through the agent's own channel, and ask the owner about
everything else. Low battery reaches a ghost through Omarchy's
`battery-low` hook calling `ghost event`.

### Crash watch

Ghost adds no crash- or failure-monitoring code either: the journal records
every core dump (systemd-coredump) and every failed unit, and `ghost help
crashes` gives the opt-in watch, a minutely routine with slug `crash-watch`
running a Bash script the ghost saves. It reads both kinds of entry after a
journal cursor kept in the service's `StateDirectory=ghost/crash-watch` (a
leaf, so systemd never changes the mode of `ghost/`, which holds the token),
advanced only past delivered events and started at the journal's end, so what
failed before the watch is not replayed. A crash is a `ghost event crash
<program>-<YYYYMMDDHH>`, at most one per program an hour; a failed service,
system or user, is a `ghost event unit <unit>-<YYYYMMDD>`, at most one per
service a day, since failing services tend to repeat. Each names its program or
unit as `--thread`, so its repeats share a conversation. CMake's feature probes
(`cmTC_<hash>`, which crash on purpose), units that are not
services, failures whose result is `core-dump` (already a crash event),
`systemd-run`'s generated `run-u<N>`/`run-p<pid>-i<N>` services (someone's
ad-hoc job; one named with `--unit`, or its core dump, is reported), and
the watch's own unit are skipped; times are UTC; exit 6 counts as delivered.
A crash's payload is its program, pid, uid, signal, executable, unit, and
stack trace; a service's is its result and that run's last 40 log lines. One
ghost per machine installs it, only when the owner asks; the routines view
pauses, inspects, and removes it, and an `ignore` regex in the script excludes
programs and services the owner names. The woken ghost diagnoses read-only and
proposes a fix with its undo; it changes, files, restarts, or sends nothing
until the owner says yes in that conversation.

The HUD counts unread `event-` conversations, which only intake creates, as
the ghost's findings (see the shell README's bar mark), and it lists them apart
from the rest, a group per event source (the listing's `source`; it folds a
source only once it has two; a pinned one or one holding a question stays with
the rest), as the summonghost.com app does in one group, so that id prefix is
contract.

### Mobile links and completion delivery

The summonghost.com app keeps the selected conversation in its URL,
`<origin>/#/<hostname>/<ghost>/<id>` (each segment URI-encoded). Transcript
responses carry a server-side `readThrough` timestamp, accepted by
`PUT …/read` to cap acknowledgement at the read start; read timestamps never
regress. A client marks a displayed owner's reply read only while the page is
visible and focused. Guests never change owner read state. Failed
navigation keeps the requested URL and shows an error instead of silently
opening a different conversation. A completed turn does not imply its result
was read; reopening the right conversation does.

`turn_end` is an opt-in owner command-hook boundary after a whole conversation
turn or owner `!command` settles, including failure; cancellation is quiet. It
cannot continue or block a turn, delay the owner's next prompt, or change the
conversation's outcome. Its payload, with that app link to the conversation as
`url`, and how its handlers run are defined in [`docs/hooks.md`](docs/hooks.md).
No notification transport, credential
store, retry queue, or push backend is added: `ghost help notifications` gives
an opt-in curl/ntfy recipe. Removing its `turn_end` handler opts out at the next
boundary. No configured handler means no outbound notification.

## Ghost home (`ghost-home/v2`)

The default root is `~/ghosts`; each direct child is one ghost:

```text
~/ghosts/<name>/
  character.md
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
The lifecycle implementation is in
[`session-host.ts`](packages/daemon/src/session-host.ts).

The checkout a ghost may edit is the clone the daemon was built from
(`GET /api/status` `source.root`), and it is the same for every ghost on the
machine: one daemon powers them all, so a self-edit powers all of them after a
build and restart. A packaged install has no checkout. No per-ghost setting
names one; the checkout's own rules, MCP, and skills never enter a session.
`settings.yml` names no cwd: every conversation runs in its own directory.

### Character and notes

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body, bounded by
`MAX_CHARACTER_BODY_LENGTH` in [`persona.ts`](packages/daemon/src/persona.ts),
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
ghost included; there is no ghost-home `AGENTS.md`. Ghost has no skills of
its own and links none into a conversation: the `ghost` CLI is a ghost's
documentation (`ghost help products` indexes the recommended products, each of
which installs its own skill; `ghost help browser` adds the owner-wide session
and task-tab locking recipe to agent-browser's own skills), and skills are
whatever each harness discovers itself, the owner's included. A conversation
directory's `.claude/skills` and `.agents/skills` lose, on its next turn, the
links earlier versions put there (those pointing into `/usr/lib/ghost/skills`,
a checkout's `skills/`, or the ghost home's `skills/`); any other link stays. `mcp.json`
rows that are enabled and valid are handed to the harness each turn (see
"Harnesses"). A ghost home carries no executable extension code; the only
hooks are the owner's `hooks.json` commands. Nothing is discovered from any
other tree: a delegated harness run with a project directory as its own cwd
respects that project's settings.

### Conversations

A conversation is one directory, `sessions/<id>/`, with `<id>` 1–128 of
`[A-Za-z0-9._-]` not starting with `.` and not a sidecar's name
(`pins.json`, `reads.json`, `questions.json`); clients mint ids (the HUD `hud-…`,
the CLI `cli-…`). The directory is
the harness's working directory and holds Ghost's log, `.conversation.jsonl`
([`conversation-log.ts`](packages/daemon/src/conversation-log.ts)): one JSON
object per line — the conversation header, owner and follow-up and hook
messages, the assistant's text and tool calls (a failed call marked
`failed`, a failed turn carrying `error`), the owner's `!` commands, title
records, `harness` records naming the harness that took over and the
session id it reported, `compacted` records of a
harness compacting its own context (its `trigger` and `preTokens`, as far as it
says: Claude Code's `compact_boundary` and pi's `compaction_end` stream one, and a
Codex compaction is read from its rollout after the pass). A torn last line is skipped, and so is a record ghostd no longer writes (earlier versions' per-run `resources`, idle `handoff` replies, `origin: "auto"` prompts, and the retired peers' messages and `sent`/`handed` records); logs are never rewritten. ghostd is the log's
only writer and only appends; an in-place edit by anything else is unsupported.
The log is the history
every client reads; each harness's own transcript is its resume state, never
imported as conversation history. The display-only session metadata inspection
below is the one exception to reading it. A conversation is listed once a message lands or the owner
names it; each row carries `preview`, the first owner text, and `title`,
the owner's name for it or else one extracted from that text without a model
(`derivedTitle`), null when nothing substantive is left. Pins, read
timestamps, and open owner questions are bounded sidecars beside the
directories. A row's `question` is what the ghost asked the owner there
(`{ text, options, askedAt }`, at most 2000 characters and six suggested
answers of 120) or null; the owner's next message to the conversation
answers it, and its deletion drops it. Ghost asks through Ghost because a
headless harness run has no one to answer its own question tool. Deletion moves the
directory to recoverable Trash in one rename; there is no fork.

### Machine-owned artifacts

- Bash browser screenshots use the owner's requested destination or XDG Pictures directory.
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
[`prompt-budget.test.ts`](packages/daemon/test/prompt-budget.test.ts). They hold only what a ghost must follow
before it would look anything up: the owner-context section names the
Documents directory as where finished work and notes live, and
the Ghost section has a ghost ask the owner with `ghost ask`, says its
harness's background jobs end with the turn, and indexes the `ghost help`
recipes by when to read one, so the CLI is the documentation: a task goes to
an agent run in its project (`ghost delegate`) only when it needs that
project's instructions, settings, or MCP servers, as the `harnesses` recipe
says. Owner documents are read only when
relevant, with the harness's own file and search tools, never injected
automatically. The prompt is rendered before every turn, so a character the
ghost rewrote is who it is on the next one.

### Harnesses

A turn is one headless run of an agent CLI, a row of
[`harness-table.ts`](packages/daemon/src/harness-table.ts): how to launch it
non-interactively with permissions pre-approved, how to resume, how it takes
MCP servers, and a parser from its JSON output to text, reasoning, tool
start/end, session, model, and error events. Rows follow the agents Omarchy
offers (`omarchy default agent`), and Ghost offers only those Omarchy reports
installed: claude, codex, grok, copilot, opencode, pi, omp, agy, ori, and
crush. Their parsers are tested against output each CLI really printed (ori's
recorded with a local stand-in for OpenRouter's API, since a run needs an
OpenRouter key), with two exceptions: omp has no recording of its own and is
tested through pi's, since it prints the same events, and agy's test feeds
lines written to its documented stream, since neither runs without the
owner's sign-in. That table is the one
per-harness adapter, and a row is launch flags plus a parser, never a chat
loop. The one deliberate exception: display-only facts absent from stdout are read
after the pass from the session record the harness wrote, found by a session id
reported by this pass (`inspectSession`: Codex's rollout file, OpenCode's
database). This reads the model/provider/effort and Codex's compactions (each
`compacted` rollout entry timestamped at or after this pass started, sized by
the `token_count` before it; logged ahead of the reply and not streamed, since
the reply has already streamed). Nothing from that inspection enters handoff
context. The owner should always be able to see what answered: each reply
records the model, provider, and effort its harness named, and the session row
carries them. Ghost keeps no inventory of a run's skills, plugins, tools, or
connected MCP servers; those are the harness's own. The HUD's MCP servers pane
manages only the ghost's additional configured servers.
Everything else — model, auth, tools, permissions, compaction, retries —
is the harness's own, configured by the owner exactly as when they run it.

The harness runs in the conversation directory with the conversation's
identity (`GHOST`, `GHOST_SESSION`) in its environment, beside the daemon's
resolved `GHOSTD_PORT`, `GHOSTD_CONFIG`, `GHOSTS_ROOT`, and `GHOSTD_HOOKS`,
which every child of ghostd (turn, hook, `ghost`) inherits, so a daemon
started with flags is the one they address. Ghost writes the
persona there as `AGENTS.md`, with `CLAUDE.md` and `GEMINI.md` linking to it;
grok, which reads none of them, gets it as `--rules`, and ori, which reads
none and takes no system prompt, gets it ahead of every prompt. Because the directory is
the conversation's own, a harness's "continue the most recent session here" is
the conversation's resume; opencode, whose continue is not
cwd-scoped, and ori, which has none, are resumed by the session id they reported. Each turn also
receives the ghost's enabled `mcp.json` rows,
`${VAR}`-expanded and with relative stdio `cwd`s resolved against the ghost
home, in that harness's own dialect: a `--mcp-config` file, copilot's
`--additional-mcp-config` file, `-c mcp_servers.*` overrides, `OPENCODE_CONFIG_CONTENT`, `ORI_MCP_CONFIG` (ori ignores a stdio `cwd`), or a
project config file in the conversation directory. A row is a stdio `command`/`args`/`env`/`cwd`
or a remote `url`/`headers`, plus `enabled` and the `envPolicy`/`headerPolicy`
expansion switches; any other field makes it invalid, since no harness dialect
carries it. The pi and omp rows forward none of these; Pi 1.2 itself
supports MCP configured by the owner. Ghost has no screen control: desktop
work goes through Omarchy's commands, app CLIs, and config files, on the bet
that Omarchy's command line keeps growing toward full coverage.

Which harness answers is decided per turn
([`session-host.ts`](packages/daemon/src/session-host.ts)): the one already
carrying the conversation (or the one the owner or ghost switched it to),
then the ghost's `settings.yml` `harness`, then
Omarchy's default agent, then every other harness Omarchy reports installed
(`ghost harnesses`). When the [local model](#local-model) is configured it
replaces that order as the default: a conversation runs on `local` when it
carries it, or is new and the ghost's `harness` is `local` or unset, and then
nothing else is tried, so the owner's content stays on the machine. A
conversation the owner switched to a harness, or a ghost whose `harness` names
one, keeps the order above. A harness that fails
before producing anything (not signed in, out of quota, not installed) hands
the prompt to the next; one that fails after answering ends the turn in an
error. A harness that failed before producing anything is then tried last,
machine-wide, until the time its refusal says access returns (`statedReturn`:
a stated UTC date or span, believed up to a month), else for an hour after a
limit (`classifyLimitMessage`) and fifteen minutes after anything else, so new
conversations start on one that answers;
it still runs when everything ahead of it fails. Answering, the owner naming
it (`ghost harness <id>`, `ghost switch <id>`), or a daemon restart ends that.
`GET /api/ghosts/:ghost/harness` rows carry `resting: { until, reason }` or
null, and `ghost harness` prints it. A harness new to a conversation receives the newest
`HANDOFF_CONTEXT_CHARS` of the log as `<conversation-so-far>`; a continuing one
receives the owner's `!` commands it has not seen as `<owner-commands>`. The
owner's `!command` runs in the owner home with the conversation's identity
and is logged; `!!command` is logged but never handed on. A message that
opens with an attached photo, `![image](…)`, is a prompt, not a command.

A turn takes no input mid-run: text queued while it runs (`/queue`, `ghost say
--follow-up`) runs as the next pass in the same stream. A
queued follow-up outranks a stop hook: no `session_stop` is asked while one
waits, and one sent while the hook runs replaces its continuation. Nor is one
asked while the ghost's open question (`ghost ask`) waits on the owner.
A turn outlives its client: a dropped stream stops only the listening, and
`POST /sessions/:id/stop` or daemon shutdown cancels it; an internal runtime
or replay-storage failure ends it in error.
Aborting a turn signals the harness's process group, SIGTERM then SIGKILL,
and nothing else. Reading images and choosing the model are the harness's;
Ghost only stores an attached image where the harness can open it.

### Background work and hooks

Background work is shell work: a ghost detaches a command into its own
low-priority transient unit (`systemd-run --user --scope -p CPUWeight=20
setsid -f`), so it yields to the owner's apps, outlives a daemon restart, and
stops by unit name; it logs to a file under `$XDG_RUNTIME_DIR`, outside the
daemon's private `/tmp`, and ends it with `ghost say --follow-up`, which
queues after a live turn or, when the conversation is idle, starts its next
turn. `GHOST` and `GHOST_SESSION` are in the Bash environment so
the CLI addresses the right conversation without flags. Ghost keeps no job
table, no jobs API, no jobs strip, and cannot cancel what it did not start;
the Ghost section (`GHOST_POLICY` in
[`prompt-policy.ts`](packages/daemon/src/prompt-policy.ts)) points at the recipe,
`ghost help background`.

There is no Ghost-owned delegation system: no worker scopes, `/tasks` API, or
job control. A ghost that wants a specialist runs the owner's installed `pi`,
`codex`, `omp`, or `claude -p` from its own Bash as `cd <dir> && ghost delegate
<harness> -- <args>` (the `ghost help harnesses` recipe, indexed by
`GHOST_POLICY` in [`prompt-policy.ts`](packages/daemon/src/prompt-policy.ts)); that harness runs
with the owner's own settings for it — its full tool set, project discovery,
auth, and session semantics.
`ghost delegate` refuses an uninstalled harness (exit 5); otherwise it runs
in the foreground in the caller's cwd and process group, with the caller's
environment and stdin, its stdout and stderr streamed through unchanged; SIGINT
and SIGTERM are forwarded to it, and once it exits the verb stops reading when
its pipes have been idle for 100ms, so a descendant holding them cannot hang
the call. The verb exits with the harness's status (128 plus the signal number
when a signal ended it, 127 when it could not start).

A delegated harness runs with its own arguments only, in the ghost's
environment.

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

Ghost hooks are `session_stop` and `turn_end`, run by ghostd
above whatever hooks the harness has of its own.
`session_stop` is awaited after each pass; `turn_end` runs detached after the
terminal frame, bounded by its own timeout (a daemon stop does not wait for it).
Their JSON protocol, failure behavior, and settings are defined in
[`docs/hooks.md`](docs/hooks.md). A stop hook owns its continuation policy;
Ghost sets `stop_hook_active` on hook continuation passes and does not impose
a host bound; `owner_prompt` and `turn_id` identify one owner request across
its continuations.
`ghostd hook-complete` gives a hook one completion by asking its own daemon
(`POST /api/ghosts/:name/complete`, below), from the harness a new
conversation would start on, or from ghostd's loaded local model where a turn
would run on it, never then a cloud one.
Ghost starts no automatic idle handoff or next-work turns. Only owner requests,
schedules, and explicit owner command hooks initiate work.

## Daemon HTTP API

`ghostd` is the only session owner. All `/api/*` routes require the bearer token
from Ghost's mode-0600 XDG-state token file or an authenticated tailnet
request; every path outside `/api` is `404`. A browser origin is admitted only
when it is loopback or in `remote.apps`. Loopback CORS allows only the exact
HUD/client methods and headers. Errors are
`{ "error": { "code": string, "message": string } }` with a meaningful HTTP
status. Request bodies and control files are bounded before allocation.

Tailnet identity is accepted only from Tailscale Serve's verified local proxy
boundary. The configured owner has full access; any other login is refused
unless `remote.guests` in the config is `"read-only"` (the default is
`"none"`). Admitted guests are read-only,
are refused the reads marked owner-only, which show file paths, hook
commands, or MCP credentials, and see no path in the ghost list;
conversations, tool calls included, are shown to them as recorded. Every
guest write is `403 read_only`.
Remote access never broadens a ghost's local tool authority.

`remote.apps` lists `https://` web app origins admitted past the Origin check
(default `["https://summonghost.com"]`; `[]` admits none, so nothing can
reach Ghost remotely). An app is admitted
by tailnet identity alone, with the roles above; a request from it carrying
`Authorization` is `403 app_token_refused`. Its responses carry
`Access-Control-Allow-Origin: <origin>` and `Vary: Origin`, its preflight
allows `GET, POST, PUT, DELETE, OPTIONS` and `content-type`, plus
`Access-Control-Allow-Private-Network: true` when asked; no credentials or
cookies. The first app's `<origin>/#add=<hostname>` link (`app` in
`GET /api/remote`) exists only while Serve is on.

Route parsing, validation, status codes, and reverse states are executable in
[`server.ts`](packages/daemon/src/server.ts) and
[`server.test.ts`](packages/daemon/test/server.test.ts). Stable route families:

Rows beginning `/sessions/` are relative to `/api/ghosts/:name`.

| Route | Contract |
|---|---|
| `GET\|PUT /api/hooks/config` | Owner-only. Read or atomically replace the admitted `hooks.json`. |
| `GET /api/ghosts/:ghost/routines`, `POST /api/ghosts/:ghost/routines/:slug/:action` | [Routine inspection and controls](#routine-inspection-and-controls); the GET is owner-only. |
| `POST /api/ghosts/:ghost/events` | [External event intake](#external-events); the GET event stream remains conversation invalidations. |
| `GET /api/status` | Owner-only `{ version, source: { commit, root }, startedAt, restartNeeded }`. `root` is the git root of the running entry script, or `null` for the packaged install; a guest is refused the row rather than shown a filesystem path. `restartNeeded` is true once the code on disk is not what runs: an install or a build rewrote the entry script after `startedAt` (its ctime, which a package cannot backdate); a commit that was not built changes nothing that runs. Updates belong to Omarchy's package manager; Ghost neither polls releases nor applies updates. |
| `GET\|POST /api/ghosts` | List or create ghosts; a tailnet guest's list carries only names. |
| `PUT /api/ghosts/:name/name` | Rename a ghost and its whole home. |
| `DELETE /api/ghosts/:name?confirm=:name` | Move a ghost home to recoverable Trash. |
| `GET\|PUT /api/ghosts/:name/character` | Read or atomically replace the persona file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `GET\|POST\|PUT\|DELETE /api/ghosts/:name/mcp…` | Owner-only. The ghost's `mcp.json` servers as stored, credentials included, and their mutation and enablement. A server added through this API starts disabled unless its row says `enabled: true`; while `mcp.json` is unreadable or malformed every mutation is refused (409) and the file left as it is. The next turn hands enabled rows to the harness, which connects them. |
| `GET\|PUT /api/ghosts/:name/harness` | `{ harnesses: [{id, usage, effort, resting}], ghostDefault, automatic }`: the installed agents Ghost has a row for, then `local` when [configured](#local-model), with the effort its launch asks for (null where the owner's setting stands), Omarchy's usage, and whether it is resting (above), the ghost's preferred agent (`settings.yml` `harness`, null for automatic), and `automatic`, the agent a new conversation would start on now by the order above (`local` when it is the default; null when none can run), which the HUD's and `ghost harness`'s "automatic" name. `PUT { harness: id \| null }` sets or clears the preference, keeping the file's other keys; an id with no row is `400 unknown_harness`. |
| `PUT /sessions/:id/harness` | `{ harness: id }` → `{ id, harness }`: the conversation's next turn runs on that agent, handed the conversation so far; a conversation with no message yet may be pointed first. A running turn refuses it with `409 session_busy`. An uninstalled agent is refused with `409 harness_not_installed`. |
| `POST /api/ghosts/:name/complete` | `{ prompt }` → `{ text }`: one completion for a command hook (`ghostd hook-complete`) on the harness a new conversation would start on, in a scratch directory with no persona, conversation, or Ghost tools, a failing harness handing it to the next (resting ones last); on the local model when a turn would run there, never then a cloud one (`409 harness_not_installed` for a ghost set to `local` with none configured). It takes no conversation lock or admission, since the turn awaiting the `session_stop` hook that asks holds its own. `502 completion_failed` names each harness's failure. |
| `POST /api/ghosts/:name/messages` | `{ prompt, sessionId?, desktop? }` → one turn as the turn wire below; a missing `sessionId` is the conversation `default`. `desktop` is the window a HUD summon came from, `{ app?, title?, cwd? }` (text of at most 256, 1024, and 4096 characters; anything else is `400 invalid_request`): the turn's first pass gets it in a `<desktop-context>` block after the prompt, its title with secret-shaped text (a value after `token`, `password`, `Bearer`, …, or a long key-like run) replaced by `[redacted]`; like hook context it is neither logged nor shown. Only the HUD's summon sends it, and no selection, clipboard, or screen content. |
| `GET /sessions/:id/stream?turn=:turn&from=:n` | The rest of a cut turn stream (turn wire below), from its event `n` on. A turn stays resumable until a minute after it ends; after that, or for a turn this daemon never ran, `404 turn_not_found`, and the client reads the transcript instead. |
| `GET /api/ghosts/:name/events` | Conversation invalidation SSE; responses close after about 1 MB or socket backpressure. Clients reconnect and refetch state to cover missed invalidations. |
| `GET /api/ghosts/:name/sessions` | Conversation rows `{ id, title, preview, source, harness, model, provider, effort, updatedAt, messageCount, pinned, unread, running, question }`, pinned first, then newest, for each conversation with a message (an owner `!command` the transcript shows counts), a title, or a run in progress; `running` marks a turn or `!command` in progress, whichever client started it, and a turn's start, each later pass, and its end announce on `/events`; `model`, `provider`, and `effort` are what `harness` last ran on, as far as it said (null otherwise); `updatedAt` is the last owner or ghost entry; `source` is the external event source that opened an `event-` conversation (null otherwise); `question` is the ghost's open question there (`/sessions/:id/question`), or null. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `PUT\|DELETE /sessions/:id/question` | Ask the owner `{ text, options? }` → `{ ok, question }`, replacing an open question there; DELETE withdraws it unanswered. |
| `GET /sessions/:id/transcript` | Paged renderable history projected from the conversation log, `{ id, messages, total, truncated, readThrough }`: `?limit=` messages (default 1000, at most 2000) from `?offset=` (counted from the oldest, default 0), out of `total` (0, not a 404, for a conversation with no log yet), `truncated` when the page is not all of them. Each message is `{ role, content, entryId }`: `role` is `user`, `assistant`, `hook`, or `compacted`, `content` a part list, and `entryId` unique per message (`e<n>` for log entry n, counting every entry from 0; `e<n>o` for a `!command`'s output). An owner or hook message's optional `contentTruncated: true` marks text cut to the log bound, an assistant message's `errorMessage` a failed turn; a `compacted` message marks where the harness compacted its context. An owner `!command` reads as the owner's `!command` followed by its output. |
| `POST /sessions/:id/attachments` | An image body (PNG, JPEG, GIF, or WebP by its bytes, at most 20 MiB), or from the machine-local token a JSON `{ path }` naming a local image to copy → `201 { path }`, `attachments/<file>` relative to the conversation directory, which need not hold a turn yet. A message names it on its own line as `![image](attachments/<file>)`; the harness opens it with its own tools and clients show it as a picture. |
| `GET /sessions/:id/attachments/:file` | The stored image. |
| `POST /sessions/:id/stop` | Abort the conversation's running turn or `!command`; its stream ends `aborted`. An idle conversation answers `409 session_not_streaming`. |
| `GET\|POST /sessions/:id/queue` | Inspect (`{ streaming, followUp }`) or enqueue `{ text }` into a live turn; it runs as the next pass of the same stream, even after a pass that failed. A stop ends the turn without running it; the HUD hands its own queued text back to the composer. An idle conversation answers `409 session_not_streaming`; `ghost say --follow-up` then posts the text as a new turn instead. A running `!command` answers `409 session_busy`. |
| `DELETE /sessions/:id` | Move the conversation directory to Trash. A running turn refuses it with `409 session_busy`. |
| `GET /api/remote/whoami` | `{ role }`: the caller's effective role, `owner` or `guest`. |
| `GET\|POST /api/remote` and `GET /api/remote/qr.svg` | Tailscale Serve status/control (`{ state, hostname, guests, owner, app, problem }`; `state` is `unavailable` only while Tailscale is missing, stopped, or logged out, and `problem` is `{ code, message, action? }`), with the app link (`app: { origin, url } \| null`), and that link's QR (`404` while it is null). Serve is HTTPS only (port 443), since the app is an HTTPS page: on a tailnet without HTTPS certificates `POST { enabled: true }` writes nothing and returns `problem.code` `https_required`, saying where to turn them on. Enabling and disabling also clear a plain-HTTP (port 80) entry an earlier version wrote. |
| `GET /api/remote/machines` | Owner-only `{ machines: [{ hostname, online }] }`: the other tailnet nodes signed in as the owner's login, tagged ones excluded, from `tailscale status`; the app probes each with `GET https://<hostname>/api/remote/whoami`. `503 tailscale_unavailable` when Tailscale does not answer. |

There are intentionally no `/plan`, `/todo`, `/live`, or `/collab` session
routes: Ghost ships no live-voice controller and no collaboration host, and
remote access is the summonghost.com app.

### Turn wire

The event union is the contract; clients must ignore unknown future event
types. See [`turn-events.ts`](packages/daemon/src/turn-events.ts). A turn
emits `start`, then ordered `harness` (a pass starting on that harness, again
on each fallback), `text_*`, `thinking` (the harness's reasoning, as
far as it shows it; never logged), `tool_execution_*`, `queue` (the follow-ups still
waiting, on every change), `owner_message` (a queued follow-up starting its pass), `hook_start`/`hook_end` (a `session_stop` command hook
running, by its `name` and `event`; clients show it as a settled turn), `session_stop_continued`, and `compacted` (the harness compacted its context, as far as its stream says; the transcript keeps it as a `compacted` message) events, and exactly one
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
HUD reaches, except attaching a photo and reading the follow-up queue, is a
named verb there (ghost list, rename, character, sessions
and their title/pin/read/delete/stop, `ghost ask` for a ghost's question to
the owner, the agent a ghost prefers (`ghost harness`)
and a conversation runs on (`ghost switch`), MCP, hooks, remote, and status), so a
ghost can drive and verify itself from Bash without raw HTTP. `-q` keeps only
a verb's primary output: what a read prints (a transcript without its paging
note, a character, ids or names, `ok` for status), and nothing for a change.
A change acknowledges in one capitalised sentence ending in a full stop; an
empty list prints a sentence saying so (`No ghosts.`), and nothing under `-q`.
`ghost help
<topic>` prints the recipes the Ghost section indexes, every one of them
([`help-topics.ts`](packages/daemon/src/help-topics.ts)),
rendered for the ghost `-g`, `$GHOST`, or the `ghost use` default names and
needing no daemon; they
are prompt-visible contract text like the policy sections. `ghost harnesses` also reads locally, never through the daemon: the
agent ids in Omarchy's `omarchy default agent` choices (from `omarchy commands
--json`; without `omarchy` on `PATH`, the ids Ghost has a row for) that
Omarchy's own `agent_present` test would call installed, in that order: an `omarchy-install-<id>-cli --check` decides when that installer
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
refreshes one, and `refresh` is the Omarchy command that does (null without
Omarchy). `-q` prints the
eligible ids, one per line. It keeps no state and throttles nothing. Addressing is
`-g`, then `$GHOST`, then the `ghost use` default, then the sole ghost, and
`-s`, then
`$GHOST_SESSION`, then the latest conversation; a ghost's own shell, and the
owner's `!` commands in a conversation, carry both variables. A session is an
id or unique prefix of a listed conversation; `say` and `switch` also take an
unlisted id as given, since one no message has landed in yet is not listed.
`-g` and `-s` exist only on the verbs whose usage lists them; elsewhere they
are unknown options. `ghost rename` moves the `ghost use` default
(`$XDG_CONFIG_HOME/ghost/cli.json`) to the new name and `ghost rm` clears it
when it names that ghost; `ghost use --none` clears it. Signing in is
the harness's own (`claude`, `codex login`, …); Ghost has no login or model
commands. There are no plan or todo commands.

## Limits and credentials

Apart from the [local model](#local-model), Ghost has no model, provider, or
credential of its own: each harness reads its
sign-in from its own configuration exactly as when the owner runs it by hand,
and its environment is the daemon's own, unscrubbed. Credential values never
enter logs; the only API response that carries them is the owner's own MCP
configuration.

Ghosts run unthrottled. Harness limits surface as typed errors, and the
harness's own retry and fallback behavior applies; Ghost's contributions are
the per-turn order of installed harnesses above and rerunning an event turn
that could not reach its model or that a daemon stop cut off ([External events](#external-events)). Omarchy usage records are
informational only. Ghost adds no turn, hosted-session, concurrency, or spend cap.

## Package boundaries

**ghost-core** is `packages/daemon`.
**ghost-omarchy** is `packages/shell` (`@ghost/omarchy`). Core never imports
the Omarchy side; `scripts/check-core-boundary.sh` proves this during lint.
Their seam is the authenticated HTTP/SSE API.

The Arch install has two packages built from the same release: `ghost-runtime`
owns the daemon, CLI, user unit, and runtime docs/licenses;
`ghost` owns the HUD, desktop launcher, icons, and shell snippets and depends on
that exact runtime version. The checkout variants are `ghost-runtime-dev` and
`ghost-dev`. Installing only the runtime keeps the daemon in the existing
graphical session without requiring Quickshell or installing Ghost UI.
An app supplies its own UI over the same authenticated HTTP/SSE API. Adding or
removing the UI neither stops the runtime nor changes ghost homes; removing the
runtime preserves owner data.

- [`packages/daemon`](packages/daemon/src/main.ts) owns ghost homes and the
  persona prompt, configuration, authentication, conversations, the harness table, MCP, hooks, lifecycle,
  HTTP, and the `ghost` CLI. Bun is the production runtime.
- [`packages/shell`](packages/shell/qml/manifest.json) is the `@ghost/omarchy`
  package: an omarchy-shell plugin, id `ferdousbhai.ghost`, declaring
  `service` (the daemon connection, the desktop presence, and the
  notifications a shut window would swallow), `panel` (the summon), and
  `bar-widget` (the ghost mark) kinds. How it behaves is its
  [README](packages/shell/README.md); what others rely on:
  - **The summon payload**, sent by the host's toggle and summon, the `ghost`
    IPC, notifications, and the desktop entry: `{}` opens the presence prompt
    (the HUD while no ghost is listed); `ghost` selects one first, if listed;
    `section` opens the HUD there; `sessionId` with `ghost` opens that
    conversation;
    `restore: true` puts the HUD back after a reload without igniting or
    listening. With nothing named, a prompt or HUD left open behind another
    app is refocused rather than closed or reopened.
  - **The `ghost` IPC target** (`omarchy-shell ghost <verb>`): `open`,
    `close`, `summon <name>`, `ask <prompt>`, `section <name>`, `refresh`,
    and `status`, a JSON object of `ghost`, `shown`, `streaming`,
    `reachable`, `activity`, `error`, and `summonKey`.
  - **Hyprland**, asked at runtime through `hyprctl eval`
    ([`DesktopKeys.qml`](packages/shell/qml/DesktopKeys.qml)) so no config
    file is edited: `SUPER+CTRL+G` unless a default-mode binding holds it (the
    owner's own, bound to this plugin or described "Summon ghost", stays; the
    shell's is described "Summon ghost (shell)"), and the named window rule
    `ghost-windows` for its two keyboard windows, titled `Ghost` and
    `Ghost prompt`. Both are withdrawn when the plugin unloads, only by the
    shell that last made them, and re-made after each config reload.
    `summonKey` is `shell`, `owner`, `taken`, or `none` (free on a `.conf`
    config, which runs no Lua, so `contrib/hyprland/ghost.conf` carries the
    key and the rule there), and empty until read.
  - **Notifications**: completed turns and terminal failures notify unless
    their conversation is viewed in the focused, visible chat or followed by
    the presence, and only those two mark replies read; cancellation is
    quiet. A toast uses the conversation title and a reply or error excerpt,
    replaces live toasts per ghost and conversation through the notification
    server's IDs, and opens its conversation with the summon payload
    `{ "ghost", "sessionId", "section": "chat" }` in Omarchy's
    `omarchy-exec-argv` hint. Optional mobile delivery is the owner's
    `turn_end` command hook.
  - **State** moves only through the authenticated HTTP/SSE API; the shell
    never edits daemon-validated ghost state (character, control files)
    directly, and it has no file editor: a tool call that wrote a file
    shows its path in the transcript and opens nothing.
  - **Dictation** is Omarchy's Voxtype: the shell reads
    `$XDG_RUNTIME_DIR/voxtype/state` and runs `voxtype record
    start|stop|cancel`. Ghost ships no speech stack of its own.
  - **Hosting**: it runs inside Omarchy's own shell process, so Ghost ships no
    shell, unit, or tray helper, and its QML imports are relative paths
    (inside the host, `qs.` resolves to Omarchy's shell root). The bar widget
    takes the host's injected `bar` facade: `barSize`, `vertical`,
    `position`, the tooltip API, the
    `shell` facade, and `triggerPress(button)` for the host's click
    forwarding. The package installs the plugin to `/usr/share/ghost/plugin`;
    the per-user link into `~/.config/omarchy/plugins/` belongs to the
    install script, which waits for shell discovery before enabling it. It
    is distributed only by the `ghost` package, never as an
    `omarchy plugin add` checkout: the HUD and the daemon are one product
    and must be the same version, and a second channel cannot hold that lock.
    Setup ends with `ghost new <name>`; harness sign-in is external.
- [`packaging`](packaging) owns package assembly, smoke tests, and release
  inputs, not user data or service activation policy. Upgrade guidance
  prints the daemon restart that loads the new bundle. A release is cut locally
  by [`packaging/release/publish.sh`](packaging/release/publish.sh): a
  `vX.Y.Z` tag on `ferdousbhai/ghost` whose GitHub release carries the source
  archive, runtime archive, and `SHA256SUMS`; Omarchy's sync reads GitHub's
  asset digests. Owners install from Omarchy's package repository. Ahead of
  its sync, `ferdousbhai.com/ghost/install.sh` (the release's `install.sh`)
  installs the same packages: from that repository when it has the latest
  release, else built with makepkg from Omarchy's own recipe for it
  (`ghost-recipe.tar.gz`), never from a second package repository, so
  `omarchy update` carries on from there. It ends with the Install menu's
  own steps (`omarchy-install-ai-ghost`, also attached to the release).

Protocols implemented by a sidecar have one detailed document:
[`docs/hooks.md`](docs/hooks.md).

Browser automation belongs to the installed `agent-browser` CLI and its skill,
invoked through the harness's Bash tool. Ghost exposes no browser MCP tool,
relay, pairing API, or browser lifecycle manager. One owner-wide session
(`owner`) shares the signed-in Chromium over loopback CDP. Conversations use
separate tabs; cooperating callers lock tab selection and each operation with
one owner-wide `flock`. Tab selection invalidates snapshot refs; separate
operations use semantic or CSS selectors. Ref-based sequences hold the lock
from selection and snapshot through action without reselecting. Tabs and CLI
state survive Ghost restarts, rename and deletion; explicitly close a task's tabs when finished, never the owner's
browser. Setup and recovery are in `ghost help browser`.

### Local model

`local` in `~/.config/ghost/config.json` is
`{ model, server?, contextSize?, idleMinutes? }`: a GGUF file used in place,
the `llama-server` executable (default: on `PATH`; a Vulkan build on Asahi),
the context in tokens (32768), and the idle minutes before it stops (5).
Configured, `local` is the default runtime ([Harnesses](#harnesses)), listed
with the harnesses (`GET …/harness`, the HUD agent menu) and chosen like one
(`ghost switch local`, `ghost harness local`); `ghost harnesses`, which reads
Omarchy, does not list it.

[`local-model.ts`](packages/daemon/src/local-model.ts) spawns one
`llama-server` on the first local turn, on a loopback port picked at spawn
with a key minted at spawn, every layer on the GPU, and stops it once unused
for the idle minutes, on daemon stop, or after a failed load. ghostd kills
only that process. Another program loading the same file (Lastbook) holds its
own copy; Ghost does not stop it, and frees its own when idle.

A local pass ([`local-turn.ts`](packages/daemon/src/local-turn.ts)) first
searches the owner's message and opens its first three file or library
hits (up to 2000 characters each), then sends the ghost's character alone
(not the stable policy sections, which direct a shell, file tools, and the
`ghost` CLI it has not; a delegated task gets the whole persona) plus the
"Running locally" section and the current time, and, as the user message,
the conversation so far (`HANDOFF_CONTEXT_CHARS`), the prompt, and the hits
and opened text in a `<found>` block marked as reference text. Thinking is
off (`enable_thinking: false`), as in Lastbook. It keeps no session of its
own, streams the same events a harness parser emits (the first search shows
as a `search` tool call), and records the model as the file's name and the
provider as `local`. It offers three tools
([`local-tools.ts`](packages/daemon/src/local-tools.ts)) for at most three
rounds, then makes one more call without them:

- `search(query)`: Recall over its folders by meaning and keywords, and
  alongside it the search Omarchy ships: ripgrep for the words in files and
  fd's file list ranked by name with fzf (Omarchy's `ff`; fd's substring
  match without fzf), over Recall's folders minus its exclusions (the home
  folder without Recall), adding what Recall did not return; so a file
  Recall has not indexed yet, or every file when Recall is missing or
  failing, is still found. Lastbook's library index (opened read-only, when
  present), and, for the model's queries but not the first search,
  `cloudmail search` and `icloud-contacts list`. Hits are numbered `S1`,
  `S2`, … in that source order for this pass only.
- `read(id, page?)`: one hit by its id, never a path: a PDF's page (column
  padding collapsed), the lines around a ripgrep match, a mail thread
  (`cloudmail thread read`), a contact, or a text file whole when it fits in
  one result, else Recall's passage, else (a hit Recall did not index) the
  file's start.
- `delegate(task)`: one headless run of a harness, in the conversation's
  directory with the ghost's persona and MCP servers, tried in the order
  above minus `local`; its reply, not its tool calls, returns to the model.
  The task leaves the machine; the section tells the model to send only
  what it needs.

Results are cut at 8000 characters, and each reaches the model in a
`<result>` block marked, like `<found>`, as reference text, not instructions. Owner content reaches a cloud model only
through a delegated task or a conversation the owner moved to a harness.
Recall's coverage is its own configuration.

## Harness and lifecycle invariants

- Never start a test daemon against `~/ghosts`, the live port 7717, or the live
  Quickshell bus. Canary/smoke daemons isolate Ghost config and owner hooks.
  Tests use scratch homes and the shell preview's private
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
- Package removal preserves ghost homes, XDG config/state, and owner documents.
- Reversible by default. Disable before delete, Trash instead of `rm`,
  checkpoint before rewrite. Every destructive move has a named way back and a
  way to see it; an audit record of an unrecoverable action is not a substitute
  for undo. The one exception: a ghost's rename or delete removes its timer
  units and routine checkpoints outright, because a timer that outlived its
  ghost would fire for a name that is gone or belongs to a later ghost;
  restoring the home from Trash restores the ghost, not its routines.
- Self-restart is a systemd handoff. The daemon never restarts itself in
  process, and there is no guardian process and no rebuild-and-restart tool. A
  ghost restarts ghostd by scheduling `systemctl --user restart ghostd.service`
  in a transient `systemd-run --user` unit whose `--description` carries the
  reason, and the same reason is in the commit. See
  [`docs/self-maintenance.md`](docs/self-maintenance.md).
- Any part of Ghost's code is a ghost's to change to fit its owner. A
  packaged install's files are pacman's and never edited: a ghost changes itself by running
  from its own clone under the owner's home (an `ExecStart` drop-in for
  ghostd, a `~/.local/bin/ghost` launcher, the plugin link), each step undone
  by removing it.

Focused tests beside the implementation are part of these contracts. GitHub
issues track unfinished work and release evidence; this file describes the
desired end state, not the backlog.
