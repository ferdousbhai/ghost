# Contracts

Stable boundaries shared by Ghost's packages and clients. Change these in one
commit with every consumer. Implementation detail belongs in code and tests.

What belongs here is what another package, a third-party client, or the
owner's own configuration relies on. How a package behaves inside itself
belongs in its README.

## Product boundary

Ghost is an owner-local Omarchy application: one owner, one machine, one ghost.

Changes simplify: state what they delete or why nothing can be deleted.
Prefer an installed CLI plus its skill, or Omarchy, over a new
Ghost tool, route, setting, or background loop. New surfaces need a constraint
those cannot meet, documented here. An external component replaces our
machinery rather than adding a parallel backend. Weigh dependencies by
installed size as well as code saved; Omarchy-shipped facilities are available
to reuse. Ask the owner before breaking these rules.

Ghost owns persona and history. The owner's data stays in the products that
hold it, each with its own app; the ghost reaches it from its shell, through
each product's command line and skill, and Ghost keeps no second view of it.
A [local model](#local-model), which ghostd runs and loops over itself,
answers every turn, so the owner's data stays on the machine; Ghost runs no
turn on a cloud model. A coding agent the owner has (Claude Code, Codex,
Antigravity) is a command the model runs from its shell, with that agent's
own sign-in, tools, and limits.
`ghostd` owns sessions and state transitions; the window and CLI are clients. The daemon binds `127.0.0.1` only (no setting moves it; a `host` key an earlier config carries is ignored, like any key Ghost does not read) and serves no web page; remote
access is the summonghost.com app over an explicit Tailscale Serve address. The
app is a static page, not a backend: it has no server, accounts, or storage;
the browser calls each machine's Serve address directly, admitted by Tailscale
identity. Whoever controls summonghost.com's code can therefore act as a
visiting owner on that owner's tailnet; `remote.apps: []` opts out, leaving no
remote client at all. The app's code is [`packages/web`](packages/web/README.md). See [concepts](docs/concepts.md) for rationale.

Durable state has three scopes:

- **Ghost-private:** character, conversations, and their
  sidecars live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, and plans live in the `Notes`
  folder of the owner's XDG Documents directory, and the owner's to-do list
  in its `Reminders` folder; the ghost reads and writes both ([Character and
  notes](#character-and-notes)).
- **External:** browser downloads, screenshots, and
  each coding agent's credentials, settings, and session store stay in the
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

Document content is unaffected by moving or removing a ghost home, or by
uninstalling Ghost.

There is no Ghost plan mode, todo store, or plan/todo API: durable
owner-visible plans and tasks belong in the owner's documents. Background work is the shell's: Ghost keeps no job table
(see "Background work and hooks").

### Mobile links and completion delivery

The summonghost.com app keeps the selected conversation in its URL,
`<origin>/#/<hostname>/<id>` (each segment URI-encoded). Transcript
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
Removing a `turn_end` handler opts out at the next boundary.

### Push alerts

At the same boundary ghostd alerts the owner's devices itself
([`push.rs`](packages/daemon/src/push.rs)): Web Push, since summonghost.com
has no backend to send one. A device that turns alerts on in the app hands
this machine its push subscription and a P-256 signing key its browser made
for it; they are kept in `$XDG_STATE_HOME/ghost/push.json` (private, at most
20 devices, newest kept). Each alert is `{ title, body, url, tag, ghost }`:
the conversation's title, a 280-character excerpt of the reply (`Failed: …`
for a failed turn), the app link, and the conversation id. It is encrypted
for that browser (RFC 8291), signed with that device's key (RFC 8292), and
posted with `curl` to the subscription's endpoint, which must be `https` on a
browser's push service (a host under Google's, Apple's, Mozilla's or
Microsoft's push domains); the service sees
only ciphertext. Delivery is not waited for and not retried by ghostd (the
service holds an alert up to a day for an offline device); a `404` or `410`
forgets the device. A cancelled turn alerts no one, and no subscribed device
means no outbound request.

## Ghost home (`ghost-home/v2`)

The default root is `~/ghosts`; a direct child holding a `character.md` is a
ghost home, and its directory name is the ghost's name:

```text
~/ghosts/<name>/
  character.md
  sessions/<id>/       (one directory per conversation)
```

A machine has one ghost: the one ghost home under the root. A daemon start
that finds none makes `<root>/ghost/` with a seeded `character.md`
([`ghosts.rs`](packages/daemon/src/ghosts.rs)); that is the only way Ghost
makes one, and it never renames, moves, or removes a home. A root holding more
than one is refused at start with an error naming them. No route, command or
URL carries the ghost's name; `GET /api/ghost` reports it. Another machine's
ghost is reached at that machine, over Tailscale
([Remote access](#remote-access)). The directory is the whole ghost: to rename it, stop
ghostd, rename the directory, and start ghostd; to remove it, `gio trash` it.
Machine credentials, owner documents, screenshots, and downloads are not in it.

The checkout a ghost may edit is the clone the daemon was built from
(`GET /api/status` `source.root`). A packaged install has no checkout. No setting
names one; the checkout's own rules, MCP, and skills never enter a session.
Every conversation runs in its own directory. A `settings.yml` an earlier
version kept in a ghost home is not read.

### Character and notes

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body, bounded by
`MAX_CHARACTER_BODY_LENGTH` in [`persona.rs`](packages/daemon/src/persona.rs),
is the persona. A seeded or blank character marks onboarding; the ghost shows
the owner a draft and waits for confirmation before replacing it.

There is no ghost-private memory store. A ghost's state across
conversations is the `Notes` folder of the owner's Documents directory, which it
keeps current unasked (it reads the note that covers a task before starting,
updates it in the same turn as a fact arrives or the task advances, and
merges notes on one subject as it goes and tidies a cluttered folder after
the task; `ghost help memory`). The owner reads and writes the same notes:
Markdown (owner facts, decisions, the ghost's reflections). Beside it is
`Reminders`, the owner's to-do list, to which the ghost adds what now waits
on the owner and where it ticks what they say is done, one Markdown checklist per
list (`Reminders/<List>.md`: `- [ ] text 📅 YYYY-MM-DD`, indented lines its
notes, `- [x]` done). Both are kept whether or not iCloud is connected, and
are the folders and formats icloud-notes and icloud-reminders sync, so
connecting iCloud later syncs what is already there. The ghost's own later
work is a systemd user timer (`ghost help background`), never a reminder. The model writes them with its
shell ([Local model](#local-model)). They are
readable by the owner
([Product boundary](#product-boundary) says what may index them).
Cleanup (merging, rewriting, and trashing stale notes) is the ghost's own,
unasked, as `ghost help memory` says; ghostd itself runs no memory
maintenance.

### Ghost-home resources

`character.md` is the one persona file, the owner's instructions for this
ghost included. Ghost has no skills of its own: the `ghost` CLI is a ghost's
documentation (`ghost help products` indexes the recommended products, each of
which installs its own skill; `ghost help browser` adds the owner-wide session
and task-tab locking recipe to agent-browser's own skills), and the model
reads the owner's skills under `~/.agents/skills`. Ghost connects no MCP
servers. A ghost home carries no executable extension code; the only hooks
are the owner's `hooks.json` commands. A conversation directory holds Ghost's
log and whatever the model's commands write there; the `AGENTS.md`,
`CLAUDE.md`, and `GEMINI.md` an earlier version wrote the persona into are
left as they are and no longer written, so a coding agent run in a project's
directory reads that project's instructions and nothing of Ghost's.

### Conversations

A conversation is one directory, `sessions/<id>/`, with `<id>` 1–128 of
`[A-Za-z0-9._-]` not starting with `.` and not a sidecar's name
(`pins.json`, `reads.json`, `questions.json`); clients mint ids (the window `app-…`,
the CLI `cli-…`). The directory is
the directory the model's commands run in and holds Ghost's log, `.conversation.jsonl`
([`conversation_log.rs`](packages/daemon/src/conversation_log.rs)): one JSON
object per line — the conversation header, owner and follow-up and hook
messages, the assistant's text and tool calls (a failed call marked
`failed`, a failed turn carrying `error`), the owner's `!` commands, and title
records. A torn last line is skipped, and so is any record ghostd does not write (an earlier version's `harness`, `compacted`, `resources` or `handoff`); logs are never rewritten. ghostd is the log's
only writer and only appends; an in-place edit by anything else is unsupported.
The log is the history
every client reads. A conversation is listed once a message lands or the owner
names it; each row carries `preview`, the first owner text, and `title`,
the owner's name for it or else one extracted from that text without a model
(`derivedTitle`), null when nothing substantive is left. Pins, read
timestamps, and open owner questions are bounded sidecars beside the
directories. A row's `question` is what the ghost asked the owner there with
its `ask` tool
(`{ text, options, askedAt }`, at most 2000 characters and six suggested
answers of 120) or null; the owner's next message to the conversation
answers it, and its deletion drops it. Deletion moves the
directory to recoverable Trash in one rename; there is no fork.

### Machine-owned artifacts

- Bash browser screenshots use the owner's requested destination or XDG Pictures directory.
  Ghost keeps no browser screenshot retention manager.
- Browser downloads belong to agent-browser and Chromium; the Bash caller
  chooses the owner's requested destination or XDG Downloads directory.
- A coding agent's credentials are its own, signed in by the owner with that
  agent. Ghost keeps no keyring, no account allow-list, and no secret
  references.
- Finished artifacts go to the destination the owner requested, defaulting to
  the owner's Documents directory when none was named. Ghost keeps no index of
  it.

### State survival

What each kind of state does under the events that move it. "The home" is the
ghost home directory, which the owner may rename while ghostd is stopped.

| State | Daemon restart | Home renamed by the owner | Rebuild + restart | Snapper rollback of `/` | Package reinstall |
| --- | --- | --- | --- | --- | --- |
| `character.md` | survives | moves with the home, byte for byte | unchanged | unchanged | preserved |
| Conversations and sidecars under `sessions/` | survives; the log is the durable history | moves with the home | unchanged | unchanged | preserved |
| Screenshots in the XDG Pictures directory | survive | not moved or renamed | unchanged | unchanged | preserved |
| The clone the daemon runs from | untouched | untouched | it is the source | unchanged | unchanged |
| The running build | re-execs the same build | unchanged | replaced | a packaged install under `/usr` rolls back; a build from a clone under the home does not | replaced |

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
ghost home and the ghost's own checkout exactly
as they were. Nothing in this table is a
backup: Trash and snapper are undo, not retention.

## Runtime contract

Every turn's system prompt is the Ghost character and the stable policy
sections, whose authoritative list and per-section size ceilings are
the budget test in [`prompt_policy.rs`](packages/daemon/src/prompt_policy.rs). They hold only what a ghost must follow
before it would look anything up: the owner-context section names the
Documents directory as where finished work and notes live, and
the Ghost section has a ghost ask the owner with its `ask` tool, says a
command it starts ends with the turn, and indexes the `ghost help`
recipes by when to read one, so the CLI is the documentation. Owner documents are read only when
relevant, from the model's shell, never injected
automatically. The prompt is rendered before every turn, so a character the
ghost rewrote is who it is on the next one.

### Turns

A turn runs on the [local model](#local-model), and on nothing else: with no
`local.model` configured it ends in an error that says so. Each pass is
handed the ghost's persona and the newest `HANDOFF_CONTEXT_CHARS` of the log
as `<conversation-so-far>`, since the model keeps no session of its own. Its
commands run in the conversation directory with the conversation's identity
(`GHOST_SESSION`) in their environment, beside the daemon's resolved
`GHOSTD_PORT`, `GHOSTD_CONFIG`, `GHOSTS_ROOT`, and `GHOSTD_HOOKS`, which every
child of ghostd (a command, a hook, `ghost`) inherits, so a daemon started
with flags is the one they address. Ghost has no screen control: desktop work goes through
Omarchy's commands, app CLIs, and config files, on the bet that Omarchy's
command line keeps growing toward full coverage.

The owner's `!command` runs in the owner home with the conversation's
identity and is logged; `!!command` is logged but never handed on. A message
that opens with an attached photo, `![image](…)`, is a prompt, not a command.

A turn takes no input mid-run: text queued while it runs (`/queue`, `ghost say
--follow-up`) runs as the next pass in the same stream. A
queued follow-up outranks a stop hook: no `session_stop` is asked while one
waits, and one sent while the hook runs replaces its continuation. Nor is one
asked while the ghost's open question (its `ask` tool) waits on the owner.
A turn outlives its client: a dropped stream stops only the listening, and
`POST /sessions/:id/stop` or daemon shutdown cancels it; an internal runtime
or replay-storage failure ends it in error.
Aborting a turn ends the model's request and signals the process group of
its running command, SIGTERM then SIGKILL, and nothing else. Ghost only
stores an attached image; reading one is up to the model's commands.

### Background work and hooks

Background work is shell work: a ghost detaches a command into its own
low-priority transient unit (`systemd-run --user --scope -p CPUWeight=20
setsid -f`), so it yields to the owner's apps, outlives a daemon restart, and
stops by unit name; it logs to a file under `$XDG_RUNTIME_DIR`, outside the
daemon's private `/tmp`, and ends it with `ghost say --follow-up`, which
queues after a live turn or, when the conversation is idle, starts its next
turn. `GHOST_SESSION` is in the Bash environment so
the CLI addresses the right conversation without flags. Ghost keeps no job
table, no jobs API, and cannot cancel what it did not start;
the Ghost section (`GHOST_POLICY` in
[`prompt_policy.rs`](packages/daemon/src/prompt_policy.rs)) points at the recipe,
`ghost help background`.

There is no Ghost-owned delegation system: no worker scopes, `/tasks` API, or
job control. For work on code the model runs the owner's coding agent from
its shell, in the project's directory ([Local model](#local-model)); that agent runs
with the owner's own settings for it — its full tool set, project discovery,
auth, and session semantics. Ghost adds no command of its own around it and
keeps no record of the run.

Ghost hooks are `session_stop` and `turn_end`, run by ghostd.
`session_stop` is awaited after each pass; `turn_end` runs detached after the
terminal frame, bounded by its own timeout (a daemon stop does not wait for it).
Their JSON protocol, failure behavior, and settings are defined in
[`docs/hooks.md`](docs/hooks.md). A stop hook owns its continuation policy;
Ghost sets `stop_hook_active` on hook continuation passes and does not impose
a host bound; `owner_prompt` and `turn_id` identify one owner request across
its continuations.
`ghostd hook-complete` gives a hook one completion by asking its own daemon
(`POST /api/complete`, below), from ghostd's loaded local model.
Ghost starts no automatic idle handoff or next-work turns. Only owner requests
and explicit owner command hooks initiate work.

## Daemon HTTP API

`ghostd` is the only session owner. All `/api/*` routes require the bearer token
from Ghost's mode-0600 XDG-state token file or an authenticated tailnet
request; every path outside `/api` is `404`. A browser origin is admitted only
when it is loopback or in `remote.apps`. Loopback CORS allows only the exact
client methods and headers. Errors are
`{ "error": { "code": string, "message": string } }` with a meaningful HTTP
status. Request bodies and control files are bounded before allocation.

Tailnet identity is accepted only from Tailscale Serve's verified local proxy
boundary. The configured owner has full access; any other login is refused
unless `remote.guests` in the config is `"read-only"` (the default is
`"none"`). Admitted guests are read-only,
are refused the reads marked owner-only, which show file paths, hook
commands, or the owner's own data;
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
[`server.rs`](packages/daemon/src/server.rs) and
[`server_tests.rs`](packages/daemon/src/server_tests.rs). Stable route families:

Rows beginning `/sessions/` are relative to `/api`.

| Route | Contract |
|---|---|
| `GET\|PUT /api/hooks/config` | Owner-only. Read or atomically replace the admitted `hooks.json`. |
| `GET /api/status` | Owner-only `{ version, source: { commit, root }, startedAt, restartNeeded }`. `root` is the git root of the running executable, or `null` for the packaged install; a guest is refused the row rather than shown a filesystem path. `restartNeeded` is true once the code on disk is not what runs: an install or a build rewrote the running executable after `startedAt` (its ctime, which a package cannot backdate); a commit that was not built changes nothing that runs. Updates belong to Omarchy's package manager; Ghost neither polls releases nor applies updates. |
| `GET /api/ghost` | `{ name }`, the machine's one ghost. No route makes, renames, or removes it ([Ghost home](#ghost-home-ghost-homev2)). |
| `GET\|PUT /api/character` | Read or atomically replace the persona file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `POST /api/complete` | `{ prompt }` → `{ text }`: one completion for a command hook (`ghostd hook-complete`) on the local model, with no persona, conversation, or tools (`409 no_local_model` with none configured; `502 completion_failed` for an empty answer). It takes no conversation lock or admission, since the turn awaiting the `session_stop` hook that asks holds its own. |
| `POST /api/messages` | `{ prompt, sessionId? }` → one turn as the turn wire below; a missing `sessionId` is the conversation `default`. |
| `GET /sessions/:id/stream?turn=:turn&from=:n` | The rest of a cut turn stream (turn wire below), from its event `n` on. A turn stays resumable until a minute after it ends; after that, or for a turn this daemon never ran, `404 turn_not_found`, and the client reads the transcript instead. |
| `GET /api/events` | Conversation invalidation SSE; responses close after about 1 MB or socket backpressure. Clients reconnect and refetch state to cover missed invalidations. |
| `GET /api/sessions` | Conversation rows `{ id, title, preview, updatedAt, messageCount, pinned, unread, running, question }`, pinned first, then newest, for each conversation with a message (an owner `!command` the transcript shows counts), a title, or a run in progress; `running` marks a turn or `!command` in progress, whichever client started it, and a turn's start, each later pass, and its end announce on `/events`; `updatedAt` is the last owner or ghost entry; `question` is the ghost's open question there, or null. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `PUT\|DELETE /api/push/subscription` | Owner-only. PUT `{ endpoint, p256dh, auth, vapidKey }` (base64url: the browser's 65-byte public key, its 16-byte secret, and the 32-byte private scalar of the signing key it made) subscribes a device to [push alerts](#push-alerts), replacing what was kept for that endpoint → `{ ok }`; `400 invalid_request` for an endpoint that is not a browser's push service or keys of the wrong kind. DELETE `{ endpoint }` → `{ ok, removed }`. |
| `POST /api/push/test` | Owner-only `{ endpoint }` → `{ ok, delivered, reason? }`: one alert to that subscribed device, waited for. |
| `GET /sessions/:id/transcript` | Paged renderable history projected from the conversation log, `{ id, messages, total, truncated, readThrough }`: `?limit=` messages (default 1000, at most 2000) from `?offset=` (counted from the oldest, default 0), out of `total` (0, not a 404, for a conversation with no log yet), `truncated` when the page is not all of them. Each message is `{ role, content, entryId }`: `role` is `user`, `assistant`, or `hook`, `content` a part list, and `entryId` unique per message (`e<n>` for log entry n, counting every entry from 0; `e<n>o` for a `!command`'s output). An owner or hook message's optional `contentTruncated: true` marks text cut to the log bound, an assistant message's `errorMessage` a failed turn. An owner `!command` reads as the owner's `!command` followed by its output. |
| `POST /sessions/:id/attachments` | An image body (PNG, JPEG, GIF, or WebP by its bytes, at most 20 MiB) → `201 { path }`, `attachments/<file>` relative to the conversation directory, which need not hold a turn yet. A message names it on its own line as `![image](attachments/<file>)`; the model opens it from its shell and clients show it as a picture. |
| `GET /sessions/:id/attachments/:file` | The stored image. |
| `POST /sessions/:id/stop` | Abort the conversation's running turn or `!command`; its stream ends `aborted`. An idle conversation answers `409 session_not_streaming`. |
| `GET\|POST /sessions/:id/queue` | Inspect (`{ streaming, followUp }`) or enqueue `{ text }` into a live turn; it runs as the next pass of the same stream, even after a pass that failed. A stop ends the turn without running it. An idle conversation answers `409 session_not_streaming`; `ghost say --follow-up` then posts the text as a new turn instead. A running `!command` answers `409 session_busy`. |
| `DELETE /sessions/:id` | Move the conversation directory to Trash. A running turn refuses it with `409 session_busy`. |
| `GET /api/remote/whoami` | `{ role }`: the caller's effective role, `owner` or `guest`. |
| `GET /api/remote` | What Tailscale Serve exposes of this daemon, read from Tailscale on each call: `{ state, hostname, guests, owner, app, command, problem }`. `state` is `on` while Serve proxies HTTPS on 443 to the daemon, `off` otherwise, and `unavailable` while Tailscale is missing, stopped, or logged out, when `problem` is `{ code, message, action? }`. `command` is Tailscale's own command that turns Serve on (`tailscale serve --bg --https=443 http://127.0.0.1:<port>`); `tailscale serve --https=443 off` turns it off. The owner or the ghost runs them: no route or `ghost` verb changes Serve. `app` is `{ origin, url }`, the first of `remote.apps` and its link adding this machine, `url` null while Serve is off. |
| `GET /api/remote/machines` | Owner-only `{ machines: [{ hostname, online }] }`: the other tailnet nodes signed in as the owner's login, tagged ones excluded, from `tailscale status`; the app probes each with `GET https://<hostname>/api/remote/whoami`. `503 tailscale_unavailable` when Tailscale does not answer. |

There are intentionally no `/plan`, `/todo`, `/live`, or `/collab` session
routes: Ghost ships no live-voice controller and no collaboration host, and
remote access is the summonghost.com app.

### Turn wire

The event union is the contract; clients must ignore unknown future event
types. See [`session_host.rs`](packages/daemon/src/session_host.rs), which builds the events, and [`server.rs`](packages/daemon/src/server.rs), which encodes them. A turn
emits `start`, then ordered `pass` (the model starting on a prompt), `text_*`, `thinking` (the model's reasoning, as
far as it shows it; never logged), `tool_execution_*` (`start`, `end`, and between them `update` with the latest of what a running owner `!command` or model command has printed), `queue` (the follow-ups still
waiting, on every change), `owner_message` (a queued follow-up starting its pass), `hook_start`/`hook_end` (a `session_stop` command hook
running, by its `name` and `event`; clients show it as a settled turn), and `session_stop_continued` events, and exactly one
terminal `done` or `error`. Tool events carry the call id; a start names the
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
[`cli/mod.rs`](packages/daemon/src/cli/mod.rs). Every daemon capability, except attaching a photo and reading the follow-up queue, is a
named verb there (character, sessions
and their title/pin/read/delete/stop, hooks, and status), so a
ghost can drive and verify itself from Bash without raw HTTP. `-q` keeps only
a verb's primary output: what a read prints (a transcript without its paging
note, a character, ids or names, `ok` for status), and nothing for a change.
A change acknowledges in one capitalised sentence ending in a full stop; an
empty list prints a sentence saying so (`No conversations.`), and nothing under `-q`.
`ghost help
<topic>` prints the recipes the Ghost section indexes, every one of them
([`help_topics.rs`](packages/daemon/src/help_topics.rs)),
needing no daemon; they
are prompt-visible contract text like the policy sections. Addressing is
`-s`, then
`$GHOST_SESSION`, then the latest conversation; a ghost's own shell, and the
owner's `!` commands in a conversation, carry that variable. No verb takes a ghost's name; `ghost status` prints it. A session is an
id or unique prefix of a listed conversation; `say` also takes an
unlisted id as given, since one no message has landed in yet is not listed.
`-s` exists only on the verbs whose usage lists it; elsewhere it
is an unknown option. Ghost has no login or model
commands. There are no plan or todo commands.

## Limits and credentials

Apart from the [local model](#local-model), Ghost has no model, provider, or
credential of its own. A coding agent the model runs reads its sign-in from
its own configuration exactly as when the owner runs it by hand, and its
environment is the daemon's own, unscrubbed. Credential values never enter
logs or API responses.

The ghost runs unthrottled: Ghost adds no turn, concurrency, or spend cap.

## Package boundaries

The seam between the packages is the authenticated HTTP/SSE API. The Arch
install is one package, `ghost`: the daemon,
CLI, user unit, docs and licenses, and the window with its launcher entry and
icons. It replaces the `ghost-runtime` package that 0.11.9 and earlier split
the daemon into. Removing it preserves owner data.

- [`packages/daemon`](packages/daemon/src/daemon.rs) owns ghost homes and the
  persona prompt, configuration, authentication, conversations, the local model and its loop, hooks, lifecycle,
  HTTP, and the `ghost` CLI. It is a native Rust binary.
- [`packages/window`](packages/window/src/main.rs) is Ghost's window
  (`ghost-window`, app id `io.github.ferdousbhai.Ghost`): a Rust and GTK 4
  app whose look (Omarchy's current theme, followed live), icons, and shared
  widgets are [omui](https://github.com/ferdousbhai/omui)'s;
  [`style.css`](packages/window/src/style.css) holds only Ghost's own rules,
  on omui's `@om_*` colours. It is a client of the
  API and keeps no data: the conversations, and the one open, with the
  answers to the ghost's open question as buttons above the composer. It finds the daemon as the CLI
  does (`GHOSTD_PORT`, else `port` in `config.json`, else 7717; the token
  file). One instance: a second launch presents the first.
  It is a member of the
  cargo workspace at the repository root, built, linted (rustfmt and clippy)
  and tested with the daemon, and the gate also walks its main flows with omui's scripted QA
  ([`dev/qa.sh`](packages/window/dev/qa.sh): a window built with the `qa`
  feature, against a scratch ghostd and a stand-in model, on a private
  broadway display); the package build's `check()`
  skips the QA, and no release build has the feature. It makes the `ghost`
  package per-architecture; the launcher entry
  `io.github.ferdousbhai.Ghost.desktop` opens it, and `--version` prints the
  release version.
- [`packages/web`](packages/web/README.md) is the summonghost.com page, the
  remote client: static files with no build step, a client of the API that
  keeps only its machine list, in the browser. It is in no package; the
  owner publishes it with
  [`publish.sh`](packages/web/publish.sh), apart from releases, so it keeps
  working against the last released daemon. The gate runs its checks
  ([`check.sh`](packages/web/check.sh)) in headless Chromium.
- [`packaging`](packaging) owns package assembly, smoke tests, and release
  inputs, not user data or service activation policy. Upgrade guidance
  prints the daemon restart that loads the new build. A release is cut locally
  by [`packaging/release/publish.sh`](packaging/release/publish.sh): a
  `vX.Y.Z` tag on `ferdousbhai/ghost` whose GitHub release carries the source
  archive and `SHA256SUMS`; Omarchy's sync reads GitHub's
  asset digests. Owners install from Omarchy's package repository. Ahead of
  its sync, `ferdousbhai.com/ghost/install.sh` (the release's `install.sh`)
  installs the same package: from that repository when it has the latest
  release, else built with makepkg from Omarchy's own recipe for it
  (`ghost-recipe.tar.gz`), never from a second package repository, so
  `omarchy update` carries on from there. It ends with the Install menu's
  own step (`omarchy-install-ai-ghost`, also attached to the release), which
  starts ghostd; its first start makes the ghost home.

Hooks have one detailed document:
[`docs/hooks.md`](docs/hooks.md).

Browser automation belongs to the installed `agent-browser` CLI and its skill,
invoked from the model's shell. Ghost exposes no browser MCP tool,
relay, pairing API, or browser lifecycle manager. One owner-wide session
(`owner`) shares the signed-in Chromium over loopback CDP. Conversations use
separate tabs; cooperating callers lock tab selection and each operation with
one owner-wide `flock`. Tab selection invalidates snapshot refs; separate
operations use semantic or CSS selectors. Ref-based sequences hold the lock
from selection and snapshot through action without reselecting. Tabs and CLI
state survive Ghost restarts; explicitly close a task's tabs when finished, never the owner's
browser. Setup and recovery are in `ghost help browser`.

### Local model

`local` in `~/.config/ghost/config.json` is
`{ model, server?, contextSize?, idleMinutes?, reasoningEffort? }`: a GGUF file used in place,
the `llama-server` executable (default: `llama-server` on `PATH`; on Asahi, point it at a Vulkan build),
the context in tokens (32768), the idle minutes before it stops (5), and how
deeply the model reasons, as its chat template names the depths (`low`).
It is what every turn runs on ([Turns](#turns)); nothing else can be chosen.

[`local_model.rs`](packages/daemon/src/local_model.rs) spawns one
`llama-server` on the first turn, on a loopback port picked at spawn
with a key minted at spawn, every layer on the GPU, and stops it once unused
for the idle minutes, on daemon stop, or after a failed load. ghostd kills
only that process. Another program loading the same file (Lastbook) holds its
own copy; Ghost does not stop it, and frees its own when idle.

A pass ([`local_turn.rs`](packages/daemon/src/local_turn.rs)) is the
smallest loop that works: it sends the ghost's whole persona, plus the "Running locally" section and the current time, and, as the
user message, the conversation so far (`HANDOFF_CONTEXT_CHARS`) and the
prompt. Nothing is searched ahead of the model. It keeps no session of its
own, streams its text, reasoning, and commands, with a running command's
latest output (at most every 100 ms). It sends `reasoning_effort`;
sampling is the model's and llama-server's own default.

It offers two tools ([`local_turn.rs`](packages/daemon/src/local_turn.rs)).
`ask(question, options)` puts a question to the owner: 2 to 4 ways forward
the model has worked out, the one it recommends first (fewer is refused, said
to the model). It records the conversation's open question
(`question` in `GET /api/sessions`), says the question in the reply with its answers
numbered, so the transcript keeps them and the next turn is handed them, and
ends the turn; the window and the app also show the answers as buttons, the
first marked, and any other answer is typed.
`bash(command)` is a command line run as the owner in the conversation's
directory, with the conversation's environment, no sandbox and no
confirmation. The owner's products are command lines with a skill each under
`~/.agents/skills`, so the shell is how the model searches, reads, writes and
acts, and how it runs a coding agent: that agent's own one-shot command,
whose steps the owner sees as it prints them and whose answer the model
reads. The section names one command only, the owner's
choice among `claude -p` (streaming JSON through `jq`, since it otherwise
prints nothing until it ends), `codex exec` and `agy -p`: Omarchy's default agent
(`omarchy default agent`) when it is one of them and installed, else the
first installed ([`coding_agent.rs`](packages/daemon/src/coding_agent.rs)). With none of the three installed it names none. Ghost teaches the
model no command of its own for this. The section asks
it to say what a command will do, and wait for the owner's yes, before one
that sends something to another person, spends money, or deletes what cannot
be restored; nothing in ghostd enforces that.

The loop runs the model's commands until it answers without one. There is no
cap on rounds, no final round without the tool, and no trimming of the
conversation: a turn that runs on is the owner's to stop, which ends the
running command and everything it started. A command cannot be typed into.
One result is bounded at 200 000 characters, its start and its end kept and
what lies between counted, and reaches the model in an `<output>` block
marked as data, not instructions. A call that is not `bash` with a `command`
is answered with what was wrong, and nothing runs.

## Lifecycle invariants

- Never start a test daemon against `~/ghosts` or the live port 7717.
  Canary daemons isolate Ghost config and owner hooks.
  Tests use scratch homes, and the window's scripted QA a private
  HOME, XDG directories and display.
- One daemon process owns a conversation, and one turn runs in it at a time;
  queued follow-ups into its live turn are the explicit exception.
- Conversation deletion reserves its conversation and publishes only durable
  state.
- Control files are bounded (1 MiB), validated, and replaced atomically by
  rename; malformed bytes are refused, and a symlinked file is followed like
  any other. Every process involved runs as the owner, so ghostd defends
  against corruption, not against the owner's own processes.
- Session/process teardown tracks exact captured owners and PIDs: a
  turn's command is the process group ghostd spawned. Settled passes close
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
  for undo.
- Self-restart is a systemd handoff. The daemon never restarts itself in
  process, and there is no guardian process and no rebuild-and-restart tool. A
  ghost restarts ghostd by scheduling `systemctl --user restart ghostd.service`
  in a transient `systemd-run --user` unit whose `--description` carries the
  reason, and the same reason is in the commit. See
  [`docs/self-maintenance.md`](docs/self-maintenance.md).
- Any part of Ghost's code is a ghost's to change to fit its owner. A
  packaged install's files are pacman's and never edited: a ghost changes itself by running
  from its own clone under the owner's home (an `ExecStart` drop-in for
  ghostd, a `~/.local/bin/ghost` link), each step undone
  by removing it.

Focused tests beside the implementation are part of these contracts. GitHub
issues track unfinished work and release evidence; this file describes the
desired end state, not the backlog.
