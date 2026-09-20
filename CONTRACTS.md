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
installed CLI plus a skill: Bash and pi's skill discovery already reach every
CLI on the machine, so a new built-in tool, route, or sidecar op has to beat
that pair at something neither can do. What Omarchy ships is free to depend
on; the install budget below is for everything else.

Installed size is part of that budget. A dependency is weighed by what it
adds to the install, not only by the code it saves, and a second
implementation of something Ghost already has is paid for twice — once in
branches, once in bytes. Ghost runs on one runtime, pi, for exactly this
reason: the alternative harness cost 4,000 lines of adapter plus 460MB of
bundled binaries to do what a ghost already delegates with `claude -p`
(see [`docs/concepts.md`](docs/concepts.md)).

When a rule here fights the task, the
answer is to say so and get the owner's decision, not to add a special case.
[`docs/concepts.md`](docs/concepts.md) lists what is deliberately absent and
what would have to change for each absence to end. `ghostd` owns sessions and state transitions; the Quickshell HUD,
terminal client, Chromium relay, and desktop helper are clients or sidecars.
The daemon listens on loopback unless the owner explicitly enables the built-in
Tailscale Serve viewer.

Durable state has three scopes:

- **Ghost-private:** character, conversations, settings, and runtime
  sidecars live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, plans, and tasks live in the
  owner's XDG Documents directory, which every ghost reads and writes with its
  runtime's native file and search tools.
- **External:** browser downloads, screenshots, systemd user timers, and
  provider credentials stay in the machine facility that owns them.

The Documents directory is resolved like the screenshot directory:
`XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`; never a
hard-coded path. It is persistent owner context, not a Ghost-owned store: Ghost
neither indexes it nor injects any part of it at session start, and the system
prompt only names the directory.

Document content is unaffected by creating, renaming, deleting, or
uninstalling a ghost.

There is no Ghost plan mode, todo store, or plan/todo API. Runtime native
planning may exist, but durable owner-visible plans and tasks belong in the
owner's documents. The one owner-visible view of them is the board:
`board.md` in the documents directory, `##` headings as columns and list items
as cards, edited by the owner and every harness with file tools and rendered
read-only by the HUD, the tailnet viewer, and `ghost board` through
`GET /api/board` ([`board.ts`](packages/daemon/src/board.ts)). Background work
is the shell's: Ghost keeps no job table (see "Ask, background work, and
hooks").

## Ghost home (`ghost-home/v2`)

The default root is `~/ghosts`; each direct child is one ghost:

```text
~/ghosts/<name>/
  character.md
  skills/<name>/SKILL.md
  commands/<name>.md
  rules/  prompts/
  AGENTS.md            (CLAUDE.md is read only when AGENTS.md is absent)
  settings.yml
  models.json
  mcp.json
  sessions/
  .pi/
```

The directory is the atomic lifecycle unit. Rename and deletion hold a
filesystem-identity lease and move the whole home on the same filesystem.
Deletion goes to freedesktop Trash, with a recoverable `.trash/` fallback for
`EXDEV`; Ghost never recursively removes a home. Machine credentials, owner
documents, screenshots, downloads, and timers are not moved with it.
The lifecycle implementation and crash recovery are in
[`home-operations.ts`](packages/daemon/src/home-operations.ts),
[`home-reservation.ts`](packages/daemon/src/home-reservation.ts), and
[`session-host.ts`](packages/daemon/src/session-host.ts).

The checkout a ghost may edit is the clone the daemon was built from
(`GET /api/status` `source.root`), and it is the same for every ghost on the
machine: one daemon powers them all, so a self-edit powers all of them after a
build and restart. A packaged install has no checkout. No per-ghost setting
names one; the checkout's own skills, rules, and MCP never enter a session.
`settings.yml` names no cwd: every conversation starts in the owner home.

### Character and notes

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body, bounded by
`MAX_CHARACTER_BODY_LENGTH` in [`home.ts`](packages/extensions/src/home.ts),
is the persona. A seeded or blank character marks onboarding; the ghost shows
the owner a draft and waits for confirmation before replacing it.

There is no ghost-private memory store. A ghost's notes — owner facts,
decisions, tasks, and its own reflections — are Markdown files under the
owner's Documents directory itself, written and
read with the runtime's native file tools, shared by every ghost and readable
by the owner. Nothing there is indexed or injected at session start.

### Declarative resources

Visible ghost-home instructions, skills, rules, Markdown commands/prompts, and
MCP form an immutable session snapshot. A ghost home carries no executable
extension code; the only hooks are the owner's `hooks.json` commands. Hidden compatibility roots inside a ghost home are not aliases.
Machine skills under `~/.agents/skills/` and `~/.pi/agent/skills/` enter at
lowest precedence, then ghost resources. There is no skill-name allowlist and
no third, per-directory resource root: a conversation's cwd is always the
owner home, and no project instructions, skills, or MCP are discovered from
any other tree. A delegated harness run with a project directory as its own
cwd respects that project's settings. The scanner is
[`declarative-resources.ts`](packages/daemon/src/declarative-resources.ts).

### Sessions and sidecars

Conversation public ids are runtime-qualified (`pi:<raw>`); pi is the only
runtime, and the prefix stays so stored ids keep saying what they are. Raw ids
remain the runtime resume identity. Transcripts
are JSONL under `sessions/`. Pins, read timestamps, and crash markers are
bounded sidecars under `sessions/`. A conversation's own cwd and its per-tool
cwds are custom entries inside its transcript
([`session-cwds.ts`](packages/daemon/src/session-cwds.ts)), which pi ignores
when building context, so a conversation is one file.
Inspecting commands or resources of a new id does not create a transcript.
`GET /sessions` omits header-only leftovers and moves idle ones to Trash,
closing an unhosted leftover first when the daemon still holds it.
A file is a conversation once a user or assistant message lands, the owner
names it, or it is a fork (a branch is listed even when rewound to empty).
Each row carries `preview`, the first user text, so an untitled conversation
still has a name in the sidebar. The HUD keeps at most one unstarted draft.

Forking copies a Pi conversation before one persisted user entry; it never
rewinds the source. Deletion moves every Ghost-owned artifact for that public id
to recoverable Trash. Both use durable markers so an unpublished or partially
moved artifact stays hidden until recovery completes: a fork stages one
transcript and publishes it with one rename, and a delete may still move
several artifacts in a home written before the cwd records moved into the
transcript. The file naming,
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
- Provider credentials live in pi's own file-backed store, `<ghost>/.pi/auth.json`
  (mode 0600), written and refreshed by pi's login flows. A custom provider's
  `apiKey` and an MCP server's headers or env are literal values in the ghost's
  private `models.json` and `mcp.json`. Ghost keeps no keyring, no account
  allow-list, and no secret references.
- Finished artifacts go to the destination the owner requested, defaulting to
  the owner's Documents directory when none was named. Ghost keeps no index of
  it.

### State survival

What each kind of state does under the events that move it. "The home" is the
ghost home directory, which moves as one unit.

| State | Daemon restart | Ghost rename | Ghost delete | Rebuild + restart | Snapper rollback of `/` | Package reinstall |
| --- | --- | --- | --- | --- | --- | --- |
| `character.md` | survives | moves with the home; the character seed is rewritten to the new name | to Trash with the home | unchanged | unchanged | preserved |
| Conversations and sidecars under `sessions/` | survives; the JSONL is the durable history | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| `.pi/` derived state | survives | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| `settings.yml`, `models.json`, `mcp.json` | survives | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
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

The session receives the Ghost character and the stable policy sections, whose
authoritative list and per-section size ceilings are
[`prompt-budget.test.ts`](packages/daemon/test/prompt-budget.test.ts). Two of
them carry contract the rest of this file relies on: the other-harnesses policy
pins the ghost to the owner home, runs each handoff with the project directory
as the harness's own cwd so the headless harness respects that project's
settings, reads the owner's agent-CLI session and weekly windows from Omarchy's usage
records and ends a limit in a handoff note in the owner's documents; the
owner-context policy names the Documents directory in one sentence and nothing
else about it. Owner documents are read only when relevant, with the runtime's
own file and search tools, never injected automatically at session start.

The operational cwd is always the owner home. A `!cd` affects only that
shell invocation and never moves the conversation. Ghost home
remains a separately named private resource root.
Prompt indexes are session-start snapshots; current data is read through the
owning tool when needed.

### Pi

The pinned pi dependency has one Ghost patch: file-loaded executable extensions
return an error, while inline factories keep pi's native implementation. This
enforces the resource boundary above and removes Jiti/Babel and its retained
terminal entry points from the bundle. Revalidate the patch when upgrading pi;
it does not change the owner's separately installed `pi` CLI.

Pi sessions use `createAgentSession`, an explicit transcript, Ghost's model
runtime and credential store, an in-memory settings manager, and an explicit
resource snapshot. Pi's inherited system prompt, ambient context/config/MCP,
automatic credential discovery, themes, prompt templates, executable code
found in the cwd, and native task tool do not enter the session. Ghost keeps Pi's native
file, search, Bash, steering/follow-up, and branch behavior; Bash is Pi's own
tool with `GHOST` and `GHOST_SESSION` added to its environment
(`conversationEnvironment` in
[`conversation-identity.ts`](packages/daemon/src/conversation-identity.ts)).
Compaction is
Pi's trigger with Ghost's answer: when Pi would summarize, Ghost's
`session_before_compact` handler returns a compaction whose summary is a
bounded recovery record (owner inputs of the current window, the unconsumed
tool batch, the prior checkpoint) and no model is called; Pi's retained tail
is `GHOST_COMPACTION_KEEP_RECENT_TOKENS` in
[`compaction.ts`](packages/daemon/src/compaction.ts). One checkpoint reminder is steered in before the
line, `new_context` rolls over on demand with the ghost's own handoff, and
`history` searches and reads the transcript across windows
([`context-windows.ts`](packages/daemon/src/context-windows.ts), a port of
pi-posthorse). Ghost adds
`ask`, browser,
screen, desktop, and MCP tools. Images are pi's read tool: it attaches them
resized, and tells a model that cannot take one that the image was omitted.
Ghost adds no second model for pictures. The exact assembly is
[`SessionHost.create`](packages/daemon/src/session-host.ts) and the seam is
[`pi-extension-bridge.ts`](packages/daemon/src/pi-extension-bridge.ts).

An MCP row's `env`, `headers`, URL credentials, per-server `cwd`, `${VAR}`
expansion, and `auth`/`oauth` blocks all reach pi as written; the ghost's
`mcp.json` is the whole configuration and nothing is copied outside the ghost
home.

### Ask, background work, and hooks

`ask` is owner input, never tool approval. Its model-facing input and output are
one to four questions, two to four described options per question,
`multiSelect`, optional previews and metadata, answers keyed by question text,
and optional per-question annotations. A pending question is pollable and the first
valid response wins. The daemon-wide timeout is `DEFAULT_ASK_TIMEOUT_SECONDS`
in [`config.ts`](packages/daemon/src/config.ts); zero waits forever. A model-facing timeout returns an empty answer map and never
invents an owner selection.

Background work is shell work: a ghost detaches a command
(`setsid -f`), logs to a file, and ends it with `ghost say --follow-up`, which
queues into a live turn or, when the conversation is idle, starts its next
turn. `GHOST` and `GHOST_SESSION` are in the Bash environment so
the CLI addresses the right conversation without flags. Ghost keeps no job
table, no jobs API, no jobs strip, and cannot cancel what it did not start;
the policy text is `BACKGROUND_WORK_POLICY` in
[`machine-skills.ts`](packages/daemon/src/machine-skills.ts).

There is no Ghost-owned delegation system and no limits tool. A ghost that
wants a specialist runs the owner's installed `pi`, `codex`, `omp`, or
`claude -p` from its own Bash, after reading that harness's window in
Omarchy's usage record (`HARNESS_LIMITS_POLICY` in
[`machine-skills.ts`](packages/daemon/src/machine-skills.ts));
that harness runs with the owner's own settings for it — its full tool set,
project discovery, auth, and session semantics — untouched by the runtime
parity list above.

Awaited harness hooks are `before_prompt` and `session_stop`. Their JSON
protocol, failure behavior, and settings are defined in
[`docs/hooks.md`](docs/hooks.md). A stop hook owns its continuation policy;
Ghost sets `stop_hook_active` on later passes and does not impose a host bound.
A ghost keeps its notes in the
owner's documents with its file tools during ordinary turns. Ghost runs no
background memory pass of its own.

Ghost registers no built-in hook of its own; every `session_stop` and
`before_prompt` behavior is a `hooks.json` command the owner chooses, and the
`builtin` section of that file admits no keys.

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
| `GET /api/relay/status` | Unauthenticated relay liveness; carries no secret. `pairing` is `{ code, since }` while an unpaired browser waits for Allow, else `null`. |
| `POST /api/relay/pair` | Owner answers the pending pairing: `{ code, allow }`. Allow hands the relay token to that browser over its socket; a stale code is `404 pairing_not_found`. |
| `GET\|PUT /api/hooks/config` | Read or atomically replace the admitted `hooks.json`. |
| `GET /api/board` | The owner's `board.md`, parsed to columns and cards; bounded; readable by tailnet guests; never written through the API. |
| `GET /api/status` | Owner-only `{ version, source: { commit, root }, update }`. `root` is the git root of the running entry script, or `null` for the packaged install; a guest is refused the row rather than shown a filesystem path. `update` is the daily release check's last answer, `{ latest, command, url }` or `null`; `command` is what installs it on this machine (`omarchy-update` for the package, pull + build + restart for a checkout). Ghost never applies an update itself; `--offline` skips the check ([`update-check.ts`](packages/daemon/src/update-check.ts)). |
| `GET\|POST /api/ghosts` | List or create ghosts. |
| `PUT /api/ghosts/:name/name` | Rename a ghost and its whole home. |
| `DELETE /api/ghosts/:name?confirm=:name` | Move a ghost home to recoverable Trash. |
| `GET\|PUT /api/ghosts/:name/character` | Read or atomically replace the persona file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `GET\|PUT\|DELETE /api/ghosts/:name/model` | Read, set, or unset `roles.chat_model` as `provider/id`; no catalog, pi validates at turn time. `DELETE` is the way out of a binding (`ghost model --none`). |
| `GET /api/ghosts/:name/providers` | Login-capable Pi providers and their sign-in state. |
| `POST /api/ghosts/:name/login` and `GET\|POST /login/:id[/input]` | Start, poll, and answer a provider login. A home rename fails a login still in flight, since pi's credential file is bound to the old path. |
| `DELETE /api/ghosts/:name/providers/:provider` | Sign out of one provider. |
| `GET\|POST\|PUT\|DELETE /api/ghosts/:name/mcp…` | Sanitized MCP catalog, mutation, enablement, reconnect, and isolated test. A server added through this API starts disabled unless its row says `enabled: true`. |
| `POST /api/ghosts/:name/greeting` | `{ greeting: string|null, onboarding }`; generation failure is a null greeting, not a 5xx. |
| `POST /api/ghosts/:name/messages` | One turn as the pi-messages SSE protocol. |
| `GET /api/ghosts/:name/events` | Conversation invalidation SSE; clients refetch affected state. |
| `GET /api/ghosts/:name/sessions` | Runtime-qualified conversation summaries with `preview`. Omits header-only leftovers and trashes idle ones. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `GET /sessions/:id/commands` | Effective pi slash-command catalog. A missing transcript returns the ghost-level catalog without creating one. |
| `GET /sessions/:id/resources` | Owner-only immutable skill/MCP admission snapshot, including source, precedence, shadowing, skips. An idle snapshot may be inspected without creating a transcript. |
| `GET /sessions/:id/transcript` | Paged renderable history projected from pi's JSONL. `historyTruncated` marks an unavailable prefix; a message's optional `contentTruncated: true` marks bounded stored text. |
| `GET\|POST /sessions/:id/ask` | Inspect or resolve one pending owner question. |
| `GET\|POST /sessions/:id/queue` | Inspect/enqueue steering or follow-up text into a live turn. A steer reaches the model mid-turn; a follow-up runs after the current result as a continuation of the same stream, and each exchange is journalled. An idle conversation answers `409 session_not_streaming`; `ghost say --follow-up` then posts the text as a new turn instead. |
| `POST /sessions/:id/branch` | Fork before one persisted Pi user entry. |
| `POST /sessions/:id/reanswer` | Reopen an historical ask result and resume that branch. |
| `DELETE /sessions/:id` | Move every Ghost-owned conversation artifact to Trash. |
| `GET /api/remote/whoami` | Effective owner/guest identity. |
| `GET\|POST /api/remote` and `GET /api/remote/qr.svg` | Tailscale Serve status/control and active URL QR. |
| `GET /manifest.webmanifest` | Public viewer manifest. |

There are intentionally no `/plan`, `/todo`, `/live`, or `/collab` session
routes: Ghost ships no live-voice controller and no collaboration host, and
remote access is the tailnet viewer alone.

### pi-messages wire

The event union is the contract; clients must ignore unknown future event
types. See [`pi-messages.ts`](packages/daemon/src/pi-messages.ts) and its
conformance tests. A turn emits `start`, ordered text/thinking/tool/command/
queue/branch events, and exactly one terminal `done` or `error`. A quota
refusal is a typed `limit_reached` event (harness, kind, window, `resetsAt`
when known) sent before that `error`; the classifier is `classifyLimitMessage`. Tool execution
events include the call id, tool name, captured cwd, and safe summary; private
reasoning is never restored through the transcript API. A standalone slash
command emits `start`, `command_output`, then zero-usage `done` and is not
persisted as an assistant answer.

### `ghost` CLI

The terminal client never edits a ghost home; every command that changes ghost
state goes through the daemon. Its command catalog is defined in
[`cli/main.ts`](packages/daemon/src/cli/main.ts). Every daemon capability the
HUD reaches is a named verb there (ghost roster, rename, character, greeting,
conversations and their title/pin/read/fork/delete/reanswer, ask,
resources, commands, model, MCP, hooks, remote, status, skill), so a
ghost can drive and verify itself from Bash without raw HTTP. `ghost help
<topic>` prints the recipes the system prompt only points at (`timers`,
`self`, `harnesses`; [`help-topics.ts`](packages/daemon/src/help-topics.ts)),
rendered for the ghost and session the shell's `$GHOST`/`$GHOST_SESSION` name
and needing no daemon; they are prompt-visible contract text like the policy
sections. Addressing is
`-g`, then `$GHOST`, then the `ghost use` default, and `-s`, then
`$GHOST_SESSION`, then the latest conversation; a ghost's own shell carries
both variables. Signing in is a provider
account, not a model, so it is the top-level `ghost login <provider>`,
`ghost logout <provider>`, and `ghost login --list`: thin clients of the
`/login`, `/providers`, and account routes above, where the daemon owns the
whole flow and the CLI holds no secret, only rendering each polled `LoginView`
and posting the answer the owner types. There are no plan or todo commands.

## Models and credentials

`models.json` owns provider policy and roles; pi's
`.pi/auth.json` owns login credentials. Credential values never enter logs or
API responses. Inherited provider/auth environment variables
are scrubbed before Pi runtime construction, process-wide and once. A harness a
ghost delegates to from Bash (`claude -p`, `codex`, `pi`) inherits that same
scrubbed environment — Ghost captures no reviewed environment of its own any
more, so a delegated harness reads its credentials from its own configuration
exactly as it does when the owner runs it by hand. The implementation and its
tests in [`env-scrub.ts`](packages/daemon/src/env-scrub.ts) are normative.

Roles are `chat_model` and `smol_model`, one binding each.
Ghost keeps no fallback chain of its own: retry and model fallback are the
runtime's, surfaced as `retry_fallback_applied`/`model_fallback` events.
`chat_model` unset leaves the choice to the
first declared provider's first model, else Pi's catalog default — Pi's live
view of what this ghost's own credentials reach. Ghost keeps no model list, no
catalog API, and no local-runner detection — a local endpoint is an ordinary
provider entry in `models.json`. A first sign-in binds the chat role from the
models pi reports as available to that credential right then, preferring one
that costs nothing so the zero-cost onboarding path cannot start billing;
dynamically-priced aggregator routers are excluded because a catalogue may list
them at zero (`bindDefaultChatModelIfUnset`). A role naming a provider Ghost no
longer has is dropped when `models.json` is read, so a home written before a
runtime was removed heals instead of failing every turn on a binding nothing
can honour. Ghost records no model name of its own: a free default is whatever
pi reports as free at sign-in time, never a constant that can be delisted.
`smol_model` serves titles, greetings, and command-hook completions. Unset, it
follows the driver: the chat provider's small tier, then the cheapest usable
model anywhere. A negative price is pi's dynamic-router sentinel, not a bargain,
on every cost key. The rule is
[`resolveSmolModel`](packages/daemon/src/smol.ts). An explicit unusable binding fails loudly rather than silently
switching models.

Ghosts run unthrottled. Provider, runtime, and context limits surface as typed
errors and use configured runtime retry/fallback behavior; Ghost adds no turn,
hosted-session, concurrency, or spend cap.

## Package boundaries

Ghost is two sides of one product plus one separate product. **ghost-core**
is everything a second interface could reuse: `packages/daemon` and
`packages/extensions`. **ghost-omarchy** is the Omarchy-only surface:
`packages/shell` (published as `@ghost/omarchy`; the directory name is
historical) and `packages/desktop-helper`. The sides meet only at named
seams — the daemon's HTTP/SSE API (which the `ghost` CLI also speaks), the
relay WebSocket protocol, and the helper JSON-lines protocol with its PATH
spawn — and core never imports the Omarchy side:
`scripts/check-core-boundary.sh` (run by `pnpm lint`) proves it.

The **browser relay** (`packages/chromium-extension`) is a separate product:
its own package, versioning, and repository — the directory is self-contained
and extracts verbatim. It meets the daemon only at the relay WebSocket
protocol ([`PROTOCOL.md`](packages/chromium-extension/PROTOCOL.md)): neither
side imports the other's source, the daemon's relay conformance test reads
the installed extension copy, and only `PROTOCOL_VERSION` ties an extension
release to a Ghost release. The runtime bundles a pinned extension release;
while the sources travel in this tree, the pin is the tree.

The Arch install has two packages built from the same release: `ghost-runtime`
owns the daemon, CLI, desktop helper, user unit, and runtime docs/licenses,
and bundles a pinned release of the separately-versioned relay extension;
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
  authentication, sessions, runtime adapters, models, MCP, hooks, lifecycle,
  HTTP, and the `ghost`
  CLI. Bun is the production runtime.
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
  terminal failures, and pending questions notify unless their conversation is
  being viewed in the focused chat panel. Cancellation is quiet. Toasts use
  the conversation title and a reply/error/question excerpt, replace live toasts
  per ghost and conversation using the notification server’s IDs, and open that
  conversation through a summon payload
  `{ "ghost": "name", "sessionId": "pi:id", "section": "chat" }`, carried in
  Omarchy’s `omarchy-exec-argv` notification hint.
  It talks only to authenticated HTTP/SSE and never edits daemon-validated ghost
  state (character, control files) directly; the one deliberate
  exception is the workbench file editor, which writes ordinary files at the
  owner's explicit direction. Dictation is Omarchy's Voxtype: the shell runs
  `voxtype record toggle` and reads `$XDG_RUNTIME_DIR/voxtype/state`; Ghost
  ships no speech stack of its own.
- [`packages/chromium-extension`](packages/chromium-extension/extension) is the
  opt-in MV3 relay into the owner's Chromium, versioned and released as its
  own product (seam: [`PROTOCOL.md`](packages/chromium-extension/PROTOCOL.md)).
  It also drives those tabs for its own side-panel chat, on the owner's
  OpenRouter account, with no ghost installed; that mode is off the wire, but
  two of its rules are visible to a ghost. A workspace id beginning `local:` is
  the panel's, so a request naming the other side's tab is refused
  `invalid_input` by name (ghost-to-ghost stays `no_page`), and a ghostd
  incarnation change retires only ghost-owned claims.
  An unpaired extension dials
  `/relay` with a six-digit code (`RELAY_PAIR_SUBPROTOCOL_PREFIX`) instead of a
  token; the owner allows that code in the HUD or with `ghost browser allow`,
  and the daemon answers with a `paired` frame carrying the token (`pairing`
  frames every ping interval keep the waiting worker alive). Pairing and
  workspace ownership are capability-scoped; there is no second browser
  backend. Client text
  frames are capped at `MAX_RELAY_MESSAGE_BYTES`
  ([`relay.ts`](packages/daemon/src/relay.ts)) before JSON parsing.
- [`packages/desktop-helper`](packages/desktop-helper/src/ghost_desktop_helper)
  is the Python JSON-lines computer-use sidecar. Root pnpm commands do not cover
  it. Its startup handshake and the extensions client agree on desktop-helper
  protocol version 2; a mismatch retires the sidecar before any request is sent.
  Startup/explicit `hello` is the diagnostic boundary; there is no `doctor` op.
  Client errors retain the operation: unavailable transport is `not_found`,
  deadlines/size are `limit_exceeded`, and malformed protocol is `invalid_format`.
- [`packaging`](packaging) owns package assembly, smoke tests, and release
  inputs, not user data or service activation policy. A release is cut locally
  by [`packaging/release/publish.sh`](packaging/release/publish.sh): a
  `vX.Y.Z` tag on `ferdousbhai/ghost` whose GitHub release carries the source
  archive, runtime archive, and `SHA256SUMS` that Omarchy's package hook
  reads. The only install path for owners is Omarchy's package repository.

Protocols implemented by a sidecar have one detailed document:
[`docs/hooks.md`](docs/hooks.md) and
[`docs/desktop-helper.md`](docs/desktop-helper.md).

## Harness and lifecycle invariants

- Never start a test daemon against `~/ghosts`, the live port 7717, or the live
  Quickshell bus. Tests use scratch homes and the shell preview's private
  HOME/XDG/dbus/Hyprland.
- One daemon process owns a session. A conversation rejects conflicting owners;
  queued steering/follow-ups into its live turn are the explicit exception.
- Home rename/delete, MCP mutation, model refresh, fork, and conversation
  deletion use explicit leases and publish only durable state.
- Control files are bounded, validated, atomically replaced, and fail closed on
  links, malformed bytes, identity changes, ambiguous recovery, or incomplete
  fsync.
- Browser/session/process teardown tracks exact captured owners and PIDs. No
  cleanup may kill by pattern or remove a broad directory.
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
