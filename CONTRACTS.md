# Contracts

Stable boundaries shared by Ghost's packages and clients. Change these in one
commit with every consumer. Implementation detail belongs in code and tests.

## Product boundary

Ghost is an owner-local Omarchy application: one owner, one machine, any number
of ghosts. `ghostd` owns sessions and state transitions; the Quickshell HUD,
terminal client, Chromium relay, and desktop helper are clients or sidecars.
The daemon listens on loopback unless the owner explicitly enables the built-in
Tailscale Serve viewer.

Durable state has three scopes:

- **Ghost-private:** character, conversations, settings, and runtime
  sidecars live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, plans, and tasks live in the
  owner's XDG Documents directory, which every ghost reads and writes with its
  runtime's native file and search tools.
- **External:** trusted projects, browser downloads, screenshots, systemd user
  timers, and provider credentials stay in the machine facility that owns
  them.

The Documents directory is resolved like the screenshot directory:
`XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`; never a
hard-coded path. It is persistent owner context, not a Ghost-owned store: Ghost
neither indexes it nor injects any part of it at session start, and the system
prompt only names the directory.

Document content is unaffected by creating, renaming, deleting, or
uninstalling a ghost.

There is no Ghost plan mode, todo store, plan/todo API, or progress UI. Runtime
native planning may exist, but durable owner-visible plans and tasks belong in
the owner's documents. Background jobs remain Ghost runtime state because they
control work currently executing in a conversation.

## Ghost home (`ghost-home/v2`)

The default root is `~/ghosts`; each direct child is one ghost:

```text
~/ghosts/<name>/
  character.md
  skills/<name>/SKILL.md
  agents/<name>.md
  commands/<name>.md
  rules/  prompts/  hooks/
  AGENTS.md  CLAUDE.md
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
documents, trusted projects, screenshots, downloads, and timers are not moved
with it.
The lifecycle implementation and crash recovery are in
[`home-operations.ts`](packages/daemon/src/home-operations.ts),
[`home-reservation.ts`](packages/daemon/src/home-reservation.ts), and
[`session-host.ts`](packages/daemon/src/session-host.ts).

`settings.yml` may name the ghost's own git clone of this repository, as a
`self:` mapping with a `checkout:` value that is an absolute path under the
owner home; any other value reads as unset. It feeds the self-maintenance
policy only. Naming it grants nothing the ghost's ordinary file tools and Bash
do not already have; the checkout's own skills, rules, and MCP load only when
the owner binds it as a conversation's project like any other. `settings.yml`
may also name `cwd:`, the directory a new conversation starts in, under the
same absolute-and-under-the-owner-home rule.

### Character and notes

`character.md` is plain Markdown with no frontmatter; by convention it opens
with a heading naming the persona. Its complete body (maximum 20,000
JavaScript UTF-16 code units) is the persona. A seeded or blank character marks onboarding; the ghost
shows the owner a draft and waits for confirmation before replacing it.

There is no ghost-private memory store. A ghost's notes — owner facts,
decisions, tasks, and its own reflections — are Markdown files under the
owner's Documents directory (`<Documents>/notes/` by convention), written and
read with the runtime's native file tools, shared by every ghost and readable
by the owner. Nothing there is indexed or injected at session start.

### Declarative resources and projects

Visible ghost-home instructions, skills, rules, Markdown commands/prompts, MCP,
and trusted `hooks/pre` and `hooks/post` factories form an immutable session
snapshot. Hidden compatibility roots inside a ghost home are not aliases.
Machine skills under `~/.agents/skills/` and `~/.pi/agent/skills/` enter at
lowest precedence, then ghost resources, then one explicitly trusted project.
There is no skill-name allowlist.

Project instructions, skills, rules, commands/prompts, and MCP are data-only.
Project plugins, executable hooks/tools, LSP, and custom subagents stay disabled
until they have a per-session isolation boundary. `agents/*.md` is preview-only
for Pi; Claude Code retains its native subagents. Project trust is bound to the
canonical filesystem identity, not a path string. The scanner and persisted
snapshot shapes are in
[`declarative-snapshot.ts`](packages/daemon/src/declarative-snapshot.ts),
[`project-binding.ts`](packages/daemon/src/project-binding.ts), and
[`project-snapshot.ts`](packages/daemon/src/project-snapshot.ts).

### Sessions and sidecars

Conversation public ids are runtime-qualified (`pi:<raw>` or
`claude-code:<raw>`). Raw ids remain the runtime resume identity. Pi transcripts
are JSONL under `sessions/`; Claude transcripts remain in Claude Code's own
storage and Ghost keeps only its resume metadata. Pins, read timestamps,
project bindings/snapshots, tool-call cwd records, and crash markers are
bounded sidecars under `sessions/`.

Each Claude conversation also gets a bounded presentation-journal sidecar
(`*.claude-code.presentation.json`): one owner prompt plus final assistant text
per settled turn, so the HUD can render the conversation. It is display state,
never runtime resume state — a journal alone never publishes a conversation id,
a journal-write failure only logs and marks the missed prefix unavailable on
the next write, and the sidecar moves to Trash with its conversation. Pi
conversations write no journal; their JSONL is already the durable history.
See [`presentation-history.ts`](packages/daemon/src/presentation-history.ts).

Forking copies a Pi conversation before one persisted user entry; it never
rewinds the source. Deletion moves every Ghost-owned artifact for that public id
to recoverable Trash. Fork and delete use durable markers so an unpublished or
partially moved artifact stays hidden until recovery completes. The file naming,
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
| Conversations and sidecars under `sessions/` | survives; Pi JSONL is the durable history | moves with the home; Claude transcripts stay in Claude Code's own storage, only resume metadata moves | to Trash with the home | unchanged | unchanged | preserved |
| `.pi/` derived state | survives | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| `settings.yml`, `models.json`, `mcp.json` | survives | moves with the home | to Trash with the home | unchanged | unchanged | preserved |
| Project trust ledger (`$XDG_STATE_HOME/ghost/project-trust.json`) | survives | untouched; the ledger is owner-wide and identity-bound, never ghost-scoped | untouched | unchanged | unchanged | preserved |
| Timers `ghost-timer-v1-*` | unaffected; systemd owns them | stopped and removed before the rename completes | stopped and removed before the delete completes | unchanged | persistent units unchanged; `$XDG_RUNTIME_DIR` units are tmpfs | preserved |
| Screenshots in the XDG Pictures directory | survive | not moved; filenames keep the old ghost name | not removed | unchanged | unchanged | preserved |
| Presentation-journal sidecars | survive | move with the home | to Trash with their conversation | unchanged | unchanged | preserved |
| The ghost's `self.checkout` clone | untouched | untouched | untouched | it is the source | unchanged | unchanged |
| The running build | re-execs the same build | unchanged | unchanged | replaced | a packaged install under `/usr` rolls back; a build from a clone under the home does not | replaced |

The rollback column assumes Omarchy's btrfs layout, where `/` is the `@`
subvolume and `/home` is `@home` with no snapper config of its own. Confirm it
before relying on the column:

```sh
findmnt -no SOURCE / /home
ls /etc/snapper/configs
```

Where `/home` is a separate subvolume that snapper does not cover, a rollback of
`/` restores the packaged install and system configuration and leaves every
ghost home, the trust ledger, the persistent timer units, and
the ghost's own checkout exactly as they were. Nothing in this table is a
backup: Trash and snapper are undo, not retention.

## Runtime contract

Both runtimes receive the same Ghost character, first
meeting policy, Omarchy computer-use policy, scheduled-work policy,
self-maintenance policy, and owner-context policy. The owner-context policy names the
Documents directory in one sentence and nothing else about it. Owner
documents are read only
when relevant, with the runtime's own file and search tools, never injected
automatically at session start.

The operational cwd defaults to `settings.yml` `cwd:`, else the owner home,
and may be rebound to one trusted project. Ghost home remains a separately named private resource root.
Prompt indexes are session-start snapshots; current data is read through the
owning tool when needed.

### Pi

Pi sessions use `createAgentSession`, an explicit transcript, Ghost's model
runtime and credential store, an in-memory settings manager, and an explicit
resource snapshot. Pi's inherited system prompt, ambient context/config/MCP,
automatic credential discovery, themes, prompt templates, executable project
code, and native task tool do not enter the session. Ghost keeps Pi's native
file, search, Bash, steering/follow-up, and branch behavior. Compaction is
Pi's trigger with Ghost's answer: when Pi would summarize, Ghost's
`session_before_compact` handler returns a compaction whose summary is a
bounded recovery record (owner inputs of the current window, the unconsumed
tool batch, the prior checkpoint) and no model is called; Pi's retained tail
stays pinned at 500 tokens. One checkpoint reminder is steered in before the
line, `new_context` rolls over on demand with the ghost's own handoff, and
`history` searches and reads the transcript across windows
([`context-windows.ts`](packages/daemon/src/context-windows.ts), a port of
pi-posthorse). Claude Code's native compaction is unaffected. Ghost adds
`ask`, background jobs, browser,
screen, desktop, and MCP tools. `inspect_image` is added only when the active
chat model does not accept image input; vision-capable Pi models use their
native image understanding. The exact assembly is
[`SessionHost.create`](packages/daemon/src/session-host.ts) and the seam is
[`pi-extension-bridge.ts`](packages/daemon/src/pi-extension-bridge.ts).

### Claude Code

`claude-code/default` uses the official Claude Agent SDK with the owner's
installed, unmodified `claude` executable and native authentication. Ghost
accepts any method for which `claude auth status --json` says `loggedIn: true`;
it never receives or stores the credential. The SDK is loaded only from Ghost's
versioned XDG data root with exact package/version/entry validation. Detailed
installation and environment guarantees are in
[`docs/claude-code-runtime.md`](docs/claude-code-runtime.md).

Claude keeps its native preset, including `AskUserQuestion`, image
understanding, subagents, background tasks, todos, web tools, and planning.
Ghost routes `AskUserQuestion` through the same daemon broker and HUD as Pi's
`ask` without denying or replacing any native tool. Claude's complete native
tool preset remains available; Ghost's browser/screen/desktop tools are
additive. Ghost disables Claude auto-memory; persistence is the owner's
documents.

The Claude Code path is native-first. A capability already supplied by the
native `claude_code` preset keeps Claude's tool name, schema, result, and
semantics; Ghost integrates its callbacks and events with daemon/HUD surfaces
instead of registering a substitute. Additive Ghost tools are limited to
Ghost-specific capabilities the preset does not supply, and must not shadow a
native tool. This rule follows the harness Claude models are trained to use and
lets new native tools arrive with the installed compatible Claude Code version
without a Ghost allowlist change.

Ghost-owned model capabilities have one cross-runtime contract even when the
runtime supplies the implementation: owner questions, image understanding,
and browser/screen/desktop control are available on both principal paths. Runtime mechanics remain native. Pi exposes its
transcript, branches, commands, steering, and `GhostJob` state through daemon
APIs; Claude serves a thin settled-turn presentation transcript and otherwise
owns the corresponding session and background-task state inside its opaque
warm query.

Two deliberate capability gaps remain. Pi's MCP manager admits ghost-home MCP
plus trusted-project MCP, including secret resolution and per-server cwd;
Claude currently admits only credential-free trusted-project MCP that its SDK
can represent and persist. Trusted ghost-home `hooks/pre` and `hooks/post`
extension factories are Pi-native executable extensions and do not enter
Claude. These exceptions must stay visible in the resource/API surfaces and
must not be presented as shared capabilities.

Claude Code can also serve the `advisor_model` role, independently of which
runtime drives the ghost: both bind `roles.advisor_model` to
`claude-code/default`. That query is not a principal session — no persona, no
project snapshot, no Ghost tools, no warm query, no resume metadata — and it is
admitted through the same SDK loader, executable probe, and reviewed child
environment as the principal path.

### Ask, jobs, and hooks

`ask` is owner input, never tool approval. Pi's model-facing `ask` input and
output match Claude Code's native `AskUserQuestion` contract: one to four
questions, two to four described options per question, `multiSelect`, optional
previews and metadata, answers keyed by question text, and optional per-question
annotations. The internal wire name remains `ask` for both runtimes so the HUD
has one predictable interaction. A pending question is pollable and the first
valid response wins. The daemon-wide timeout defaults to 120 seconds; zero
waits forever. A model-facing timeout returns an empty answer map and never
invents an owner selection.

In Pi, every Bash command is represented by a `GhostJob`. Foreground commands
wait for the configured budget, then continue as background jobs. Job
completion is fed back into the same conversation; closing the session cancels
running jobs. Jobs are process-local and an unopened conversation reports
`[]`. Claude keeps its native Bash and background tasks; they do not appear in
the `GhostJob` API.

There is no Ghost-owned delegation system. A ghost that wants a specialist
runs the owner's installed `pi`, `codex`, or `claude -p` from its own Bash;
that harness owns its project discovery, tools, auth, and session semantics.

Awaited harness hooks are `before_prompt` and `session_stop`. Their JSON
protocol, failure behavior, and settings are defined in
[`docs/hooks.md`](docs/hooks.md). A ghost keeps its notes in the
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
| `GET /api/relay/status` | Unauthenticated relay liveness; carries no secret. |
| `GET\|PUT /api/hooks/config` | Read or atomically replace the admitted `hooks.json`. |
| `GET /api/status` | Owner-only `{ version, source: { commit, root } }`. `root` is the git root of the running entry script, or `null` for the packaged install; a guest is refused the row rather than shown a filesystem path. |
| `GET\|POST /api/ghosts` | List or create ghosts. |
| `PUT /api/ghosts/:name/name` | Rename a ghost and its whole home. |
| `DELETE /api/ghosts/:name?confirm=:name` | Move a ghost home to recoverable Trash. |
| `GET\|PUT /api/ghosts/:name/character` | Read or atomically replace the persona file; the write refuses an oversize body, the read serves one so it can be shortened. |
| `GET\|PUT /api/ghosts/:name/model` | Read or set `roles.chat_model` as `provider/id`; no catalog, pi validates at turn time. |
| `GET /api/ghosts/:name/providers` | Login-capable Pi providers and their sign-in state. |
| `POST /api/ghosts/:name/login` and `GET\|POST /login/:id[/input]` | Start, poll, and answer a provider login. A home rename fails a login still in flight, since pi's credential file is bound to the old path. |
| `DELETE /api/ghosts/:name/providers/:provider` | Sign out of one provider. |
| `GET\|POST\|PUT\|DELETE /api/ghosts/:name/mcp…` | Sanitized MCP catalog, mutation, enablement, reconnect, and isolated test. A server added through this API starts disabled unless its row says `enabled: true`. |
| `POST /api/ghosts/:name/greeting` | `{ greeting: string|null, onboarding }`; generation failure is a null greeting, not a 5xx. |
| `POST /api/ghosts/:name/messages` | One turn as the pi-messages SSE protocol. |
| `GET /api/ghosts/:name/events` | Conversation invalidation SSE; clients refetch affected state. |
| `GET /api/ghosts/:name/sessions` | Runtime-qualified conversation summaries. |
| `GET\|PUT\|DELETE /sessions/:id/project…` | Read, preview, bind/reload/unbind, or abandon an unpublished trusted-project draft. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `GET /sessions/:id/commands` | Effective Pi slash-command catalog; Claude returns not supported. |
| `GET /sessions/:id/resources` | Owner-only immutable skill/MCP admission snapshot, including source, precedence, shadowing, skips. Pi may open an idle snapshot for inspection; Claude reports only a live warm query and otherwise returns 409. |
| `GET /sessions/:id/jobs` | `{ jobs }` for the open conversation. |
| `POST /sessions/:id/jobs/:jobId/cancel` | `{ outcome, job }`; unknown is 404. |
| `GET /sessions/:id/transcript` | Paged renderable history. Pi projects its own JSONL; Claude serves the settled-turn presentation journal. `historyTruncated` marks an unavailable prefix; a message's optional `contentTruncated: true` marks bounded stored text. |
| `GET\|POST /sessions/:id/ask` | Inspect or resolve one pending owner question. |
| `GET\|POST /sessions/:id/queue` | Inspect/enqueue Pi steering or follow-up text. |
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
queue/branch events, and exactly one terminal `done` or `error`. Tool execution
events include the call id, tool name, captured cwd, and safe summary; private
reasoning is never restored through the transcript API. A standalone slash
command emits `start`, `command_output`, then zero-usage `done` and is not
persisted as an assistant answer.

### `ghost` CLI

The terminal client never edits a ghost home; every command that changes ghost
state goes through the daemon. Its command catalog is defined in
[`cli/main.ts`](packages/daemon/src/cli/main.ts). It supports conversation,
ask, job, model, MCP, hooks, status, and skill operations. Signing in is a provider
account, not a model, so it is the top-level `ghost login <provider>`,
`ghost logout <provider>`, and `ghost login --list`: thin clients of the
`/login`, `/providers`, and account routes above, where the daemon owns the
whole flow and the CLI holds no secret, only rendering each polled `LoginView`
and posting the answer the owner types. There are no plan or todo commands.

## Models and credentials

`models.json` owns provider policy, roles, and retry chains; pi's
`.pi/auth.json` owns login credentials. Credential values never enter logs or
API responses. Inherited provider/auth environment variables
are scrubbed before Pi runtime construction. Claude Code receives a separate
reviewed operational/selector environment captured before the global scrub; its
credential-bearing values are excluded. The implementation allowlists and tests
in [`env-scrub.ts`](packages/daemon/src/env-scrub.ts) and
[`claude-code.ts`](packages/daemon/src/claude-code.ts) are normative.

Roles are `chat_model`, `smol_model`, and `advisor_model`, each with an
optional ordered fallback chain. `claude-code/default` is valid as the primary
chat runtime and as the primary `advisor_model`; it is not a Pi provider model
and is never a role fallback. `chat_model` unset leaves the choice to Pi's
catalog default; Ghost keeps no model list, no catalog API, and no local-runner
detection — a local endpoint is an ordinary provider entry in `models.json`.
`smol_model` serves titles, greetings, and command-hook completions; unset, it
chooses the cheapest usable model, treating an authenticated subscription as
zero marginal cost. `advisor_model` is the frontier teacher and reads images
for a chat model that cannot; unset, Ghost's preference list picks a strong
reasoner. An explicit unusable binding fails loudly rather than silently
switching models.

Ghosts run unthrottled. Provider, runtime, and context limits surface as typed
errors and use configured runtime retry/fallback behavior; Ghost adds no turn,
hosted-session, concurrency, or spend cap.

## Package boundaries

- [`packages/extensions`](packages/extensions/src/index.ts) is runtime-neutral:
  ghost-home parsing, prompt construction, pure tools, browser/desktop clients,
  and the `extension-api.ts` seam. It imports no daemon or UI.
- [`packages/daemon`](packages/daemon/src/main.ts) owns configuration,
  authentication, sessions, runtime adapters, models, MCP, hooks, lifecycle,
  jobs, HTTP, and the `ghost`
  CLI. Bun is the production runtime.
- [`packages/shell`](packages/shell/qml/shell.qml) is a Quickshell client. It
  talks only to authenticated HTTP/SSE and never edits daemon-validated ghost
  state (character, control files) directly; the one deliberate
  exception is the workbench file editor, which writes ordinary files at the
  owner's explicit direction.
- [`packages/chromium-extension`](packages/chromium-extension/extension) is the
  opt-in MV3 relay into the owner's Chromium. Pairing and workspace ownership
  are capability-scoped; there is no second browser backend. Client text
  frames are capped at 32 MiB of UTF-8 before JSON parsing.
- [`packages/desktop-helper`](packages/desktop-helper/src/ghost_desktop_helper)
  is the Python JSON-lines computer-use sidecar. Root pnpm commands do not cover
  it. Its startup handshake and the extensions client agree on desktop-helper
  protocol version 2; a mismatch retires the sidecar before any request is sent.
  Startup/explicit `hello` is the diagnostic boundary; there is no `doctor` op.
  Client errors retain the operation: unavailable transport is `not_found`,
  deadlines/size are `limit_exceeded`, and malformed protocol is `invalid_format`.
- [`packaging`](packaging) owns package assembly, smoke tests, and release
  candidates, not user data or service activation policy.

Protocols implemented by a sidecar have one detailed document:
[`docs/hooks.md`](docs/hooks.md),
[`docs/claude-code-runtime.md`](docs/claude-code-runtime.md), and
[`docs/desktop-helper.md`](docs/desktop-helper.md). Release publication's
fail-closed state machine lives in
[`docs/release-publication.md`](docs/release-publication.md).

## Harness and lifecycle invariants

- Never start a test daemon against `~/ghosts`, the live port 7717, or the live
  Quickshell bus. Tests use scratch homes and the shell preview's private
  HOME/XDG/dbus/Hyprland.
- One daemon process owns a session. A conversation rejects conflicting owners;
  queued Pi steering/follow-ups are the explicit exception.
- Home rename/delete, project transitions, MCP mutation, model refresh, fork,
  and conversation deletion use explicit leases and publish only durable state.
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
