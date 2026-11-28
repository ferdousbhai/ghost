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
`ghostd` owns the conversation and its state transitions; the bar and CLI are
clients. The daemon binds `127.0.0.1` only (no setting moves it) and serves no
web page; remote access is the summonghost.com page over an explicit Tailscale
Serve address. The page is static, not a backend: it has no server, accounts,
or storage; the browser calls each machine's Serve address directly, admitted
by Tailscale identity. Whoever controls summonghost.com's code can therefore
act as a visiting owner on that owner's tailnet; `remote.apps: []` opts out,
leaving no remote client at all. The page's code is
[`packages/web`](packages/web/README.md).

The rest belongs to the machine. Omarchy owns package updates, the theme the
bar follows, and dictation; git, journald, systemd, and Trash provide code
history, diagnostics, restart, and recovery. Ghost duplicates none of them,
and has no shell plugin, widget in Omarchy's bar, or tray helper.

Durable state has three scopes:

- **Ghost-private:** the character, the conversation and the ghost's topic
  documents live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, and plans live in the `Notes`
  folder of the owner's XDG Documents directory, and the owner's to-do list
  in its `Reminders` folder; the ghost reads and writes both ([Notes and
  reminders](#notes-and-reminders)). A file made for the owner goes where
  they asked, else to that directory.
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

### Mobile links and completion delivery

The summonghost.com page keeps the selected machine in its URL,
`<origin>/#/<hostname>` (URI-encoded). Transcript
responses carry a server-side `readThrough` timestamp, accepted by
`PUT /api/conversation/read` to cap acknowledgement at the read start; read
timestamps never regress. A client marks a displayed reply read only while the
page is visible and focused. Failed
navigation keeps the requested URL and shows an error instead of silently
opening a different machine. A completed turn does not imply its result
was read; opening that machine's conversation does.

### Push alerts

When a whole turn or owner `!command` settles, including in
failure (a cancelled one is quiet), ghostd alerts the owner's devices itself
([`push.rs`](packages/daemon/src/push.rs)): Web Push, since summonghost.com
has no backend to send one. A device that turns alerts on in the page hands
this machine its push subscription and a P-256 signing key its browser made
for it; they are kept in `$XDG_STATE_HOME/ghost/push.json` (private, at most
20 devices, newest kept). Each alert is `{ title, body, url }`:
the ghost's name, a 280-character excerpt of the reply (`Failed: …`
for a failed turn), and the page's link to this machine. It is encrypted
for that browser (RFC 8291), signed with that device's key (RFC 8292), and
posted with `curl` to the subscription's endpoint, which must be `https` on a
browser's push service (a host under Google's, Apple's, Mozilla's or
Microsoft's push domains); the service sees
only ciphertext. Delivery is not waited for and not retried by ghostd (the
service holds an alert up to a day for an offline device); a `404` or `410`
forgets the device. A cancelled turn alerts no one, and no subscribed device
means no outbound request.

## Ghost home

A machine has one ghost, and its home is one fixed directory,
`$XDG_DATA_HOME/ghost` (default `~/.local/share/ghost`; `home` in the config,
`GHOST_HOME`, or `--home` move it):

```text
~/.local/share/ghost/
  character.md
  conversation/        (the one conversation)
  topics/              (one Markdown document per topic, kept by the ghost)
```

A daemon start that finds no `character.md` there makes one, seeded
([`home.rs`](packages/daemon/src/home.rs)). Ghost never moves or removes a
home. The ghost's name is its
persona's title, the leading `# ` heading of `character.md`, read when it is
needed, else `ghost`; to rename the ghost, retitle its persona. No route,
command or URL carries the name; `GET /api/ghost` reports it, with where
the topic documents are and how many. Another
machine's ghost is reached at that machine, over Tailscale
([Daemon HTTP API](#daemon-http-api)). The directory is the whole ghost: to remove
it, `gio trash` it.
Machine credentials, owner documents, screenshots, and downloads are not in it.

The checkout a ghost may edit is the clone the daemon was built from
(`GET /api/status` `source.root`). A packaged install has no checkout. No setting
names one; the checkout's own rules, MCP, and skills never enter a turn.

### Character

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body, bounded by
`MAX_CHARACTER_BODY_LENGTH` in [`home.rs`](packages/daemon/src/home.rs),
is the persona. A seeded or blank character marks onboarding; the ghost shows
the owner a draft and waits for confirmation before replacing it.

### Topic documents

`topics/` holds one Markdown file per topic the conversation has dealt with,
named for the topic, its first line a one-line summary
([`topics.rs`](packages/daemon/src/topics.rs)). They are the ghost's lasting
memory of each topic: what the owner asked for and decided, what was done and
found, what is still open, what it was told to remember. The ghost writes
them with its shell at each handoff ([Local model](#local-model)) and reads
one with `cat` when the conversation returns to its topic. A note of a note
would let old topics fade; a document per topic does not. They outlive the
conversation: starting over clears the conversation, not what the ghost
knows. They are plain files, the owner's to read, edit and delete, and
`ghost status` says where they are and how many. Ghost keeps no index of
them: ghostd lists `topics/*.md` (not hidden files) with each file's first
line, cut at 120 characters, when a conversation starts and when a handoff
is written, and at no other time.

### Notes and reminders

Apart from the topic documents there is no ghost-private memory store. What
the owner should also read is a note in the `Notes` folder of their Documents
directory: Markdown the owner and the ghost both read and write, which the
ghost keeps current and tidy unasked. Beside it is `Reminders`, the owner's
to-do list, one Markdown checklist per list (`Reminders/<List>.md`:
`- [ ] text 📅 YYYY-MM-DD`, indented lines its notes, `- [x]` done), to which
the ghost adds what now waits on the owner. Both are kept whether or not
iCloud is connected, and are the folders and formats icloud-notes and
icloud-reminders sync, so connecting iCloud later syncs what is already
there. The ghost's own later work is a systemd user timer, never a reminder.
How the ghost keeps all of this is the Owner context section of its prompt
and `ghost help memory`; ghostd itself runs no memory maintenance.

### The conversation

A ghost has exactly one conversation: no threads, no ids, no titles, on any
surface. It is one directory, `conversation/`: the directory the model's
commands run in, holding Ghost's log, `.conversation.jsonl`
([`conversation_log.rs`](packages/daemon/src/conversation_log.rs)), the
images the owner attached (`attachments/`), and two sidecars
([`sidecars.rs`](packages/daemon/src/sidecars.rs)). The log is one JSON
object per line — the conversation header (with `topics`, what the
conversation was told of the topic documents as it started, when there were
any), owner and follow-up and hook
messages, the assistant's parts in the order they happened (`thinking`, its
reasoning; `handoff`, the note that stands for the conversation before it,
with `covers`, how many of the log's entries that is, and `topics` as the
header has it, after the parts of the pass that wrote it;
`text`; `toolCall` with its `arguments`, `output`, the whole of
what it returned as the model was given it, and `failed` on one that
failed; a failed turn carries `error`), and the owner's `!` commands. A torn
last line is skipped, and so is any record or part ghostd does not write; logs are never rewritten. Until 1.0 the log's shape may change without a way to read an earlier one. ghostd is the log's
only writer and only appends; an in-place edit by anything else is unsupported.
The log is the history every client reads. `GET /api/conversation` summarises
it: `preview` is the first owner text. The sidecars are `.question.json`, what
the ghost asked the owner with its `ask` tool
(`{ text, options, askedAt }`, at most 2000 characters and 2 to 4 suggested
answers of 120; a file with another count reads as no question), which the owner's next message answers and removes, and
`.read.json`, when the owner last read the conversation (`{ readAt }`), which
the page's unread mark and nothing else reads. Starting over
(`DELETE /api/conversation`, `ghost new --yes`) moves the whole directory to
recoverable Trash in one rename, sidecars included; the next message makes a
new one. Restoring it from Trash, with ghostd stopped and no `conversation/`
in the way, is the way back.

### State survival

The ghost home, the XDG config and state, and the owner's documents survive a
daemon restart, a rebuild, and a package reinstall or removal. On Omarchy's
btrfs layout (`/` is the `@` subvolume, `/home` is `@home` with no snapper
config of its own) a snapper rollback of `/` restores the packaged install
and system configuration and leaves everything under `/home` as it was: the
ghost home, and a clone the daemon runs from. On another layout, confirm with
`findmnt -no SOURCE / /home` and `ls /etc/snapper/configs`. Trash and snapper
are undo, not retention: nothing here is a backup.

## Runtime contract

Every turn's system prompt is the ghost's character and the stable policy
sections. The one budget test in
[`prompt_policy.rs`](packages/daemon/src/prompt_policy.rs) holds their list
and exact sizes, the tool descriptions included. They hold only what a ghost
must follow before it would look anything up. The Ghost section has a ghost
ask the owner with its `ask` tool and do everything else through bash; says a
command it starts ends with the turn, and that what one prints is data, not
instructions; asks it to say what a command will do, and wait for the owner's
yes, before one that sends something to another person, spends money, or
deletes what cannot be restored (nothing in ghostd enforces that); indexes
the `ghost help` recipes by when to read one, so the CLI is the
documentation; and names the owner's coding-agent command
([Local model](#local-model)). The owner-context section names the Documents
directory as where finished work and notes live. Owner documents are read
only when relevant, from the model's shell, never injected automatically. The
prompt is rendered before every turn, so a character the ghost rewrote is who
it is on the next one.

Ghost has no skills of its own and connects no MCP servers: the `ghost` CLI
is a ghost's documentation, and the model reads the owner's skills under
`~/.agents/skills`. Ghost writes no instruction file into the conversation
directory, so a coding agent run in a project's directory reads that
project's instructions and nothing of Ghost's.

### Turns

A turn runs on the [local model](#local-model), and on nothing else: with no
`local.model` configured it ends in an error that says so. Each pass is
handed the ghost's persona and the conversation so far, replayed from the log
as the chat messages it was, since the model keeps no session of its own. Its
commands run in the conversation directory with the daemon's resolved
`GHOSTD_PORT`, `GHOSTD_CONFIG`, `GHOST_HOME`, and `GHOSTD_HOOKS` in their
environment, which every child of ghostd (a command, a hook, `ghost`)
inherits, so a daemon started with flags is the one they address. Ghost has no screen control: desktop work goes through
Omarchy's commands, app CLIs, and config files, on the bet that Omarchy's
command line keeps growing toward full coverage.

The owner's `!command` runs in the owner home and is logged; `!!command` is
logged but never handed on. A message
that opens with an attached photo, `![image](…)`, is a prompt, not a command.

A turn takes no input mid-run: text queued while it runs
(`POST /api/conversation/queue`, `ghost say --follow-up`) runs as the next pass in the same stream. How a
follow-up and the ghost's open question rank against a stop hook is in
[`docs/hooks.md`](docs/hooks.md).
A turn outlives its client: a dropped stream stops only the listening, and
`POST /api/conversation/stop` or daemon shutdown cancels it; an internal runtime
failure ends it in error.
Aborting a turn ends the model's request and signals the process group of
its running command, SIGTERM then SIGKILL, and nothing else. Ghost only
stores an attached image; reading one is up to the model's commands.

### Background work and hooks

Background work is shell work: a ghost detaches a command into its own
low-priority transient unit (`systemd-run --user --scope -p CPUWeight=20
setsid -f`), so it yields to the owner's apps, outlives a daemon restart, and
stops by unit name; it logs to a file under `$XDG_RUNTIME_DIR`, outside the
daemon's private `/tmp`, and ends it with `ghost say --follow-up`, which
queues after a live turn or, when none is running, starts the next
turn. Ghost keeps no job
table, no jobs API, and cannot cancel what it did not start;
the Ghost section points at the recipe,
`ghost help background`.

Ghost's one hook is `session_stop`, a command of the owner's that ghostd runs
and awaits after each pass, and that may continue the turn. Its protocol,
continuation rules, failure behavior, settings, and the `ghostd hook-complete`
bridge are in [`docs/hooks.md`](docs/hooks.md), and nowhere else. ghostd
starts no turn of its own: only the owner's messages and the owner's hooks
initiate work.

## Daemon HTTP API

`ghostd` alone owns the conversation. All `/api/*` routes require the bearer token
from Ghost's mode-0600 XDG-state token file or an authenticated tailnet
request; every path outside `/api` is `404`. A request carrying an `Origin` is
admitted only when that origin is in `remote.apps`; local clients send none.
Errors are
`{ "error": { "code": string, "message": string } }` with a meaningful HTTP
status. Request bodies and control files are bounded before allocation.

Tailnet identity is accepted only from Tailscale Serve's verified local proxy
boundary, and only the owner's: the configured owner, else the login this
node belongs to. Anyone else on the tailnet is refused (`401`), as is a
request without a token or that identity.
Remote access never broadens a ghost's local tool authority.

`remote.apps` lists `https://` web app origins admitted past the Origin check
(default `["https://summonghost.com"]`; `[]` admits none, so nothing can
reach Ghost remotely). An app is admitted
by tailnet identity alone; a request from it carrying
`Authorization` is `403 app_token_refused`. Its responses carry
`Access-Control-Allow-Origin: <origin>` and `Vary: Origin`, its preflight
allows `GET, POST, PUT, DELETE, OPTIONS` and `content-type`, plus
`Access-Control-Allow-Private-Network: true` when asked; no credentials or
cookies. The first app's `<origin>/#add=<hostname>` link (`app` in
`GET /api/remote`) exists only while Serve is on.

Route parsing, validation, status codes, and reverse states are executable in
[`server.rs`](packages/daemon/src/server.rs) and
[`server_tests.rs`](packages/daemon/src/server_tests.rs). Stable route families:

| Route | Contract |
|---|---|
| `GET\|PUT /api/hooks/config` | Read or atomically replace the admitted `hooks.json`. |
| `GET /api/status` | `{ version, source: { commit, root }, startedAt, restartNeeded }`. `root` is the git root of the running executable, or `null` for the packaged install. `restartNeeded` is true once the code on disk is not what runs: an install or a build rewrote the running executable after `startedAt` (its ctime, which a package cannot backdate); a commit that was not built changes nothing that runs. Updates belong to Omarchy's package manager; Ghost neither polls releases nor applies updates. |
| `GET /api/ghost` | `{ name, topics: { path, count } }`, the machine's one ghost and its [topic documents](#topic-documents). No route makes, renames, or removes it ([Ghost home](#ghost-home)). |
| `GET\|PUT /api/character` | Read or atomically replace the character file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `POST /api/complete` | `{ prompt }` → `{ text }`: one completion for a command hook (`ghostd hook-complete`) on the local model, with no persona, conversation, or tools (`409 no_local_model` with none configured; `502 completion_failed` for an empty answer). It takes no admission, since the turn awaiting the `session_stop` hook that asks holds its own. |
| `POST /api/messages` | `{ prompt }` → one turn of the conversation as the turn wire below; `409 conversation_busy` while another runs. |
| `GET /api/events` | Conversation invalidation SSE, each event `{ type: "conversation-updated", updatedAt }`; a client that stops reading is dropped. Clients reconnect and refetch state to cover missed invalidations. |
| `GET /api/conversation` | The conversation, `{ preview, updatedAt, messageCount, unread, running, question }`: `preview` and `updatedAt` are null until a message lands (an owner `!command` the transcript shows counts); `updatedAt` is the last owner or ghost entry; `unread` is true when that is later than the read mark; `running` marks a turn or `!command` in progress, whichever client started it, and a turn's start, each later pass, and its end announce on `/api/events`; `question` is the ghost's open question, or null. |
| `PUT /api/conversation/read` | `{ readThrough? }` (a timestamp as the transcript gave it, `YYYY-MM-DDTHH:MM:SS[.fff]Z`, no later than now, else `400`; now when absent) → `{ ok, readAt }`: the read mark, which never moves back. `404` before there is a conversation. |
| `PUT\|DELETE /api/push/subscription` | PUT `{ endpoint, p256dh, auth, vapidKey }` (base64url: the browser's 65-byte public key, its 16-byte secret, and the 32-byte private scalar of the signing key it made) subscribes a device to [push alerts](#push-alerts), replacing what was kept for that endpoint → `{ ok }`; `400 invalid_request` for an endpoint that is not a browser's push service or keys of the wrong kind. DELETE `{ endpoint }` → `{ ok, removed }`. |
| `POST /api/push/test` | `{ endpoint }` → `{ ok, delivered, reason? }`: one alert to that subscribed device, waited for. |
| `GET /api/conversation/transcript` | Paged renderable history projected from the conversation log, `{ messages, total, truncated, readThrough }`: `?limit=` messages (default 1000, at most 2000) from `?offset=` (counted from the oldest, default 0), both whole numbers of zero or more, else `400`, out of `total` (0, not a 404, with no log yet), `truncated` when the page is not all of them. Each message is `{ role, content, entryId }`: `role` is `user`, `assistant`, or `hook`, `content` a part list, and `entryId` unique per message (`e<n>` for log entry n, counting every entry from 0; `e<n>o` for a `!command`'s output). An owner or hook message's optional `contentTruncated: true` marks text cut to the log bound, an assistant message's `errorMessage` a failed turn. An owner `!command` reads as the owner's `!command` followed by its output. |
| `POST /api/conversation/attachments` | An image body (PNG, JPEG, GIF, or WebP by its bytes, at most 20 MiB) → `201 { path }`, `attachments/<file>` relative to the conversation directory, which need not hold a turn yet. A message names it on its own line as `![image](attachments/<file>)`; the model opens it from its shell and clients show it as a picture. |
| `GET /api/conversation/attachments/:file` | The stored image. |
| `POST /api/conversation/stop` | Abort the running turn or `!command`; its stream ends `aborted`. A handoff under way is stopped too, with the turn waiting for it or on its own. With none of them running, `409 conversation_not_streaming`. |
| `GET\|POST /api/conversation/queue` | Inspect (`{ streaming, followUp }`) or enqueue `{ text }` into a live turn; it runs as the next pass of the same stream, even after a pass that failed. A stop ends the turn without running it. With none running, `409 conversation_not_streaming`; `ghost say --follow-up` then posts the text as a new turn instead. A running `!command` answers `409 conversation_busy`, which `ghost say --follow-up` waits out (for up to ten minutes) before it sends. |
| `DELETE /api/conversation` | Start over: move the conversation directory to Trash. A running turn refuses it with `409 conversation_busy`; `404` when there is no conversation. |
| `GET /api/remote/whoami` | `{ role: "owner" }`: anyone admitted is the owner. |
| `GET /api/remote` | What Tailscale Serve exposes of this daemon, read from Tailscale on each call: `{ state, hostname, owner, app, command, problem }`. `state` is `on` while Serve proxies HTTPS on 443 to the daemon, `off` otherwise, and `unavailable` while Tailscale is missing, stopped, or logged out, when `problem` is `{ code, message, action? }`. `command` is Tailscale's own command that turns Serve on (`tailscale serve --bg --https=443 http://127.0.0.1:<port>`); `tailscale serve --https=443 off` turns it off. The owner or the ghost runs them: no route or `ghost` verb changes Serve. `app` is `{ origin, url }`, the first of `remote.apps` and its link adding this machine, `url` null while Serve is off. |
| `GET /api/remote/machines` | `{ machines: [{ hostname, online }] }`: the other tailnet nodes signed in as the owner's login, tagged ones excluded, from `tailscale status`; the page probes each with `GET https://<hostname>/api/remote/whoami`. `503 tailscale_unavailable` when Tailscale does not answer. |

### Turn wire

The event union is the contract; clients must ignore unknown future event
types. See [`conversation_host.rs`](packages/daemon/src/conversation_host.rs), which builds the events, and [`server.rs`](packages/daemon/src/server.rs), which encodes them. A turn
emits `start`, then ordered `pass` (the model starting on a prompt), `text_*`, `thinking` (the model's reasoning, as
far as it shows it), `tool_execution_*` (`start`, `end`, and between them `update` with the latest of what a running owner `!command` or model command has printed), `queue` (the follow-ups still
waiting, on every change), `owner_message` (a queued follow-up starting its pass), `hook_start`/`hook_end` (a `session_stop` command hook
running, by its `name` and `event`; clients show it as a settled turn), and `session_stop_continued` events, and exactly one
terminal `done` or `error`. Tool events carry the call id; a start names the
tool and the directory it runs in, an update carries a bounded output
summary, and an end names the tool and carries `isError`, the summary, and
`output`, the whole of what the call returned as the model was given it.
Nothing of a turn is held back from the owner: the log keeps the reasoning,
each call whole, and all it printed (below), `ghost show` and the page show
them, and the bar shows what was said and the command
running. An owner `!command` is
one `bash` tool card, then `done`.

One response carries the whole turn. The turn runs on its own thread and
never waits on its reader: a reader more than 8 MiB behind, or whose socket
takes no write for 30 s, is dropped, its response ending with no terminal,
and the turn runs on into the log, where the client reads it as transcript.
The response ends after the terminal, once the conversation is free, so a
client that reads to the end and posts again is never answered
`409 conversation_busy`.

### `ghost` CLI

The terminal client never edits a ghost home; every command that changes ghost
state goes through the daemon. Its command catalog is defined in
[`cli/mod.rs`](packages/daemon/src/cli/mod.rs). What a ghost needs to drive
and verify itself is a named verb there (character, the conversation's say,
show, stop and starting over, hooks, and status, which also says where the
topic documents are, how many there are, and what the conversation is doing),
so it needs no raw HTTP. Attaching a photo, push subscriptions, the machine
list, and marking the conversation read are the page's alone. `-q` keeps only
a verb's primary output: what a read prints (a transcript without its paging
note, a character, names, `ok` for status), and nothing for a change.
A change acknowledges in one capitalised sentence ending in a full stop; an
empty list prints a sentence saying so (`No hooks configured.`), and nothing under `-q`.
`ghost help <topic>` prints the recipes the Ghost section indexes, every one
of them ([`help_topics.rs`](packages/daemon/src/help_topics.rs)), needing no
daemon; they are prompt-visible contract text like the policy sections.

## Limits and credentials

Apart from the [local model](#local-model), Ghost has no model, provider, or
credential of its own. A coding agent the model runs reads its sign-in from
its own configuration exactly as when the owner runs it by hand, and its
environment is the daemon's own, unscrubbed. Credential values never enter
logs or API responses. What the model hands a coding agent goes wherever that
agent sends it; nothing else of a turn leaves the machine but an encrypted
[push alert](#push-alerts).

The ghost runs unthrottled: Ghost adds no turn, concurrency, or spend cap.

## Package boundaries

The seam between the packages is the authenticated HTTP/SSE API. The Arch
install is one package, `ghost`: the daemon,
CLI, user unit, docs and licenses, and the bar with its launcher entry and
icons. Removing it preserves owner data.

- [`packages/daemon`](packages/daemon/src/daemon.rs) owns the ghost home and the
  persona prompt, configuration, authentication, the conversation, the local model and its loop, hooks, lifecycle,
  HTTP, and the `ghost` CLI. It is a native Rust binary.
- [`packages/bar`](packages/bar/README.md) is Ghost's bar (`ghost-bar`, app
  id `io.github.ferdousbhai.Ghost`): a prompt near the bottom of the screen
  with the whole of what the ghost answers above it, and Ghost's only desktop
  surface. It is Rust and GTK 4, a layer-shell surface (`gtk4-layer-shell`; a
  plain undecorated window where the display has none) with
  [omui](https://github.com/ferdousbhai/omui)'s look. It is a client of the
  API and keeps no data; putting it away stops nothing. It finds the daemon
  with the CLI's own client (`ghostd::client`), afresh for each request; a
  port, config or token file it cannot use is an error line in the bar. One
  instance: `ghost-bar` again shows the first with its prompt and gives it
  the keyboard, which is how a key binding summons it, and a launch of
  another version replaces the one running. Nothing listens
  until the owner starts dictation: it types into the bar's prompt as into
  any focused field, which the prompt holds the keyboard for, and Ghost has
  no speech stack of its own. Where the machine has Omarchy's dictation the
  prompt shows a microphone, which a click toggles it with, and beside it the
  key Hyprland has bound as Omarchy's "Toggle dictation" (none where it
  cannot be told). The launcher entry
  `io.github.ferdousbhai.Ghost.desktop` opens it, and `--version` prints the
  release version. It is a member of the cargo workspace at the repository
  root, built, linted and tested with the daemon; the gate also walks its
  main flows with omui's scripted QA ([`dev/qa.sh`](packages/bar/dev/qa.sh)),
  which the package build's `check()` skips, and no release build has the
  `qa` feature. How it behaves on screen, key by key, is in
  [its README](packages/bar/README.md).
- [`packages/web`](packages/web/README.md) is the summonghost.com page, the
  remote client: static files with no build step, a client of the API that
  keeps only its machine list, in the browser. It is in no package; the
  owner publishes it with
  [`publish.sh`](packages/web/publish.sh), apart from releases, so it keeps
  working against the last released daemon. The gate runs its checks
  ([`check.sh`](packages/web/check.sh)) in headless Chromium.
- [`packaging`](packaging) owns package assembly, its checks
  ([`check.sh`](packaging/check.sh)), and release inputs, not user data or service activation policy. The Arch package is
  per-architecture, and its upgrade guidance prints the daemon restart that
  loads the new build. How a release is cut, how Omarchy's repository takes
  it, and the installer that runs ahead of that are in
  [`packaging/release/README.md`](packaging/release/README.md).

Browser automation belongs to the installed `agent-browser` CLI and its skill,
invoked from the model's shell. One owner-wide session (`owner`) shares the
signed-in Chromium over loopback CDP, each task in its own tab under one
owner-wide `flock`; tabs survive Ghost restarts. The conventions, setup and
recovery are `ghost help browser`.

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

What the server has read is kept across a stop. It runs with
`--slot-save-path $XDG_CACHE_HOME/ghost/slot` (a 0700 directory); before
every stop ghostd saves its one slot there (`slot.bin`, made 0600, about
150 KB a token, so up to some 5 GB at a full 32K context), with `slot.json`
naming the model and context it was saved from, and after the next start
restores it when those match. One file, replaced at each stop: the server
writes `slot.saving`, which becomes `slot.bin` by rename once whole, and
`slot.json` is written last, so a save that fails or is cut leaves no slot.
The conversation the slot held is then not read again.

A pass ([`local_turn.rs`](packages/daemon/src/local_turn.rs)) is the
smallest loop that works: it sends the ghost's whole system prompt as the system message, the same bytes every turn; then the
conversation so far as the messages it was (`conversation_messages`: what
each side said, and each earlier call with what it returned, whole;
reasoning is not handed on);
then the prompt. Nothing in it changes between turns, the time included (the
model runs `date`), so llama-server reuses what it has already read and only
the new message costs time. Nothing is searched ahead of the model.

The conversation grows as long as the context permits, by the server's own
count of each request. When a turn ends past three quarters of the context,
a handoff starts in the background: the ghost is asked, as the conversation's
own next message (`handoff_prompt`, which lists the
[topic documents](#topic-documents) there are), first to bring those
documents up to date with its shell, updating a topic's file rather than
writing a second, and then to reply with only a short note of where things
stand: what it was in the middle of and what the owner is waiting for. The
pass is a turn's, commands and all, but for three things: nobody is shown it,
its `ask` is refused, and its note is what it said after its last command.
It is logged as one assistant entry, the pass's reasoning, words and commands
and then the `handoff` part, which says how many of the log's entries the
note covers. From then on a turn is handed the note in place of those entries
and of the handoff's own pass. The log and every client still hold the whole
conversation. A handoff that ends without a note, or is stopped, logs
nothing and is tried again after the next turn (from the newest part that
fits, when it was the handoff that outgrew the context); what it had already
written to the documents stays.

The first message a turn is handed says where the topic documents are, to
`cat` one when the conversation returns to its topic, and which there are:
the index as ghostd derived it when the conversation started (the log's
header) or when the newest note was written (after that note), read back from
the log and never from the directory. Those are the two moments at which the
server reads everything after the system message anyway, so the index costs
no second reading; in the persona, or derived at each turn, a document
written or edited mid-conversation would change what the server has already
read and make it read the whole conversation again. A document written since
is therefore not in the index until the next handoff.

A turn that arrives during a handoff waits for it, saying so,
and then runs from the note. It waits rather than running beside it because
the model server has one slot (`--parallel 1`) and answers one request at a
time: a second slot would halve the context each gets, share the GPU between
the two, and make the note's slot read the whole conversation again, since
what a slot has read is its own. So the wait is the handoff's own length, and
nothing is cancelled or done twice, unless the owner stops it: a stop ends
the handoff and its running command with the turn.

A request the server refuses for length is retried once with the newest of
the conversation that fits, and the handoff that follows is written from
that same newest part.

It offers two tools ([`local_turn.rs`](packages/daemon/src/local_turn.rs)).
`ask(question, options)` puts a question to the owner: 2 to 4 ways forward
the model has worked out, the one it recommends first (any other number is refused,
said to the model). It records the conversation's open question
(`question` in `GET /api/conversation`), says the question in the reply with its answers
numbered, so the transcript keeps them, and ends the turn (the next turn is
handed the call and `Asked.`); the bar and the page also show the answers as buttons, the
first marked, and any other answer is typed.
`bash(command)` is a command line run as the owner in the conversation's
directory, with the conversation's environment, no sandbox and no
confirmation. The owner's products are command lines with a skill each under
`~/.agents/skills`, so the shell is how the model searches, reads, writes and
acts, and how it runs a coding agent: that agent's own one-shot command,
whose steps the owner sees as it prints them and whose answer the model
reads. The Ghost section names one command only, the owner's
choice among `claude -p` (streaming JSON through `jq`, since it otherwise
prints nothing until it ends), `codex exec` and `agy -p`: Omarchy's default agent
(`omarchy default agent`) when it is one of them and on PATH
([`coding_agent.rs`](packages/daemon/src/coding_agent.rs)); otherwise it names none. Ghost teaches the
model no command of its own for this.

The loop runs the model's commands until it answers without one. There is no
cap on rounds, no final round without the tool, and no trimming of the
conversation: a turn that runs on is the owner's to stop, which ends the
running command and everything it started. A command cannot be typed into.
One result is bounded at 200 000 characters, its start and its end kept and
what lies between counted, and reaches the model inside a bare `<output>` block. A call that is neither `bash` with a `command`
nor `ask` is answered with what was wrong, and nothing runs.

## Lifecycle invariants

- Tests and canaries run on scratch state: never the owner's ghost home, the
  live port 7717, the owner's hooks, or the owner's desktop. The canary
  recipe is in
  [`docs/self-maintenance.md`](docs/self-maintenance.md#canary-before-adopting).
- One daemon process owns the conversation, and one turn runs in it at a time;
  queued follow-ups into its live turn are the explicit exception.
- Starting over reserves the conversation and publishes only durable
  state.
- Control files are bounded (1 MiB), validated, and replaced atomically by
  rename; malformed bytes are refused, as is a config key ghostd does not know,
  by name; a symlinked file is followed like any other, except the token
  file. Every process involved runs as the owner, so ghostd defends
  against corruption, not against the owner's own processes.
- Process teardown tracks exact captured owners and PIDs: a
  turn's command is the process group ghostd spawned. Settled passes close
  inherited pipes and emit no late events; cancellation kills surviving members
  of that group even after its leader exits. Normal completion leaves detached
  background jobs alone. No cleanup may kill by
  pattern or remove a broad directory.
- Logs redact secrets and private payloads. A log line's structured fields,
  the ghost's name included, are JSON in its journal `MESSAGE`.
- Package install/upgrade gates Ghost on nothing owner-level: no application,
  CLI, or machine skill is required before enabling the service.
- Package removal preserves the ghost home, XDG config/state, and owner documents.
- Reversible by default. Disable before delete, Trash instead of `rm`,
  checkpoint before rewrite. Every destructive move has a named way back and a
  way to see it; an audit record of an unrecoverable action is not a substitute
  for undo.
- Self-restart is a systemd handoff. The daemon never restarts itself in
  process, and there is no guardian process and no rebuild-and-restart tool:
  a ghost schedules the restart in a transient unit that survives the daemon.
  The recipe is `ghost help self`; see
  [`docs/self-maintenance.md`](docs/self-maintenance.md#restarting-yourself).
- Any part of Ghost's code is a ghost's to change to fit its owner. A
  packaged install's files are pacman's and never edited: a ghost changes
  itself by running from its own clone, each step undone by removing it
  ([`docs/self-maintenance.md`](docs/self-maintenance.md)).

Focused tests beside the implementation are part of these contracts. GitHub
issues track unfinished work and release evidence; this file describes the
desired end state, not the backlog.
