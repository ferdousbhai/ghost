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

- **Ghost-private:** character, memory, conversations, settings, and runtime
  sidecars live in one ghost home.
- **Owner-shared:** notes, knowledge, decisions, plans, and tasks live in an
  Obsidian vault selected by Obsidian. Every ghost accesses it exclusively with
  the official Obsidian CLI and the linked upstream `obsidian-cli` skill.
- **External:** trusted projects, browser downloads, screenshots, systemd user
  timers, and Secret Service credentials stay in the machine facility that owns
  them.

Ghost never infers an Obsidian vault path, scans for `.obsidian`, assumes
`~/Documents`, or reads/writes vault files directly. The CLI's current vault is
the default; `vault=<name>` selects an owner-named vault. Obsidian state is
unaffected by creating, renaming, deleting, or uninstalling a ghost.

There is no Ghost plan mode, todo store, plan/todo API, or progress UI. Runtime
native planning may exist, but durable owner-visible plans and tasks belong in
Obsidian. Background jobs remain Ghost runtime state because they control work
currently executing in a conversation.

## Ghost home (`ghost-home/v2`)

The default root is `~/ghosts`; each direct child is one ghost:

```text
~/ghosts/<name>/
  character.md
  memory/*.md
  skills/<name>/SKILL.md
  agents/<name>.md
  commands/<name>.md
  rules/  prompts/  tools/  hooks/
  settings.yml
  models.json
  mcp.json
  sessions/
  .pi/
  .memory-maintenance.json
```

The directory is the atomic lifecycle unit. Rename and deletion hold a
filesystem-identity lease and move the whole home on the same filesystem.
Deletion goes to freedesktop Trash, with a recoverable `.trash/` fallback for
`EXDEV`; Ghost never recursively removes a home. Machine credentials, Obsidian,
trusted projects, screenshots, downloads, and timers are not moved with it.
The lifecycle implementation and crash recovery are in
[`home-operations.ts`](packages/daemon/src/home-operations.ts),
[`home-reservation.ts`](packages/daemon/src/home-reservation.ts), and
[`session-host.ts`](packages/daemon/src/session-host.ts).

### Character and memory

`character.md` is plain Markdown with no frontmatter. Its first heading is the
display title and its complete body (maximum 20,000 JavaScript UTF-16 code
units) is the persona. A seeded or blank character marks onboarding; the ghost
shows the owner a draft and waits for confirmation before replacing it.

`memory/*.md` is this ghost's private internal continuity: subjective
reflections, ghost-specific interpretations, and commitments about its own
behavior. It is not the owner's knowledge store. Owner facts and preferences,
shared decisions, project knowledge, notes, plans, and tasks go to Obsidian.
The owner can inspect memory for transparency; other ghosts do not consume it.

Each memory is one Markdown file named by a lowercase kebab-case slug. Content
is limited to 2,000 UTF-16 code units and 6,001 bytes. The session-start index
lists at most 4,000 characters of complete slugs, newest modification first.
Unsafe, linked, invalid-UTF-8, or oversized entries are skipped; direct reads
fail rather than truncate. API writes redact common credential forms before
disk. Exact parsing, descriptor confinement, redaction, and limits are defined
in [`memory-file.ts`](packages/extensions/src/memory-file.ts),
[`home.ts`](packages/extensions/src/home.ts), and their tests.

Native runtime file tools can write character and memory directly. They do not
receive the API writer's validation/redaction guarantees; the system prompt
states the hard limits and the next cold session rejects or omits invalid data.

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
project bindings/snapshots, tool-call cwd records, idle-maintenance journals,
and crash markers are bounded sidecars under `sessions/`.

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
- Provider and MCP credential values live in Linux Secret Service. `models.json`
  and `mcp.json` hold service/account references only. See
  [`docs/keyring.md`](docs/keyring.md).
- Finished artifacts go to the destination the owner requested. Ghost has no
  default Documents destination or automatic document index.

## Runtime contract

Both runtimes receive the same Ghost character, private memory index, first
meeting policy, Omarchy computer-use policy, scheduled-work policy, and shared
Obsidian policy. The prompt links
`/owner/.agents/skills/obsidian-cli/SKILL.md`; the runtime resolves `/owner` to
the actual owner home. Obsidian content is fetched only when relevant through
`obsidian`, never injected automatically at session start.

The operational cwd defaults to the owner home and may be rebound to one
trusted project. Ghost home remains a separately named private resource root.
Prompt indexes are session-start snapshots; current data is read through the
owning tool when needed.

### Pi

Pi sessions use `createAgentSession`, an explicit transcript, Ghost's model
runtime and credential store, an in-memory settings manager, and an explicit
resource snapshot. Pi's inherited system prompt, ambient context/config/MCP,
automatic credential discovery, themes, prompt templates, executable project
code, and `task` tool do not enter the session. Ghost keeps Pi's native file,
search, Bash, compaction, steering/follow-up, and branch behavior, and adds
`ask`, background jobs, image inspection, browser, screen, desktop, and MCP
tools. The exact assembly is
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

Claude keeps its native preset, including subagents, todos, web tools, and
planning. Ghost disables only surfaces it owns or cannot safely route:
`AskUserQuestion`, native cron/scheduling, push notifications, remote triggers,
and scheduled wakeups. Ghost disables Claude auto-memory; shared persistence is
Obsidian and private continuity is Ghost memory.

### Ask, jobs, hooks, and maintenance

`ask` is owner input, never tool approval. A pending question is pollable and
the first valid response wins. The daemon-wide timeout defaults to 120 seconds;
zero waits forever. On timeout, an explicit model recommendation is submitted;
otherwise no selection is invented.

Every Bash command is represented by a `GhostJob`. Foreground commands wait for
the configured budget, then continue as background jobs. Job completion is fed
back into the same conversation; closing the session cancels running jobs.
Jobs are process-local and an unopened conversation reports `[]`.

Awaited harness hooks are `before_prompt`, `session_stop`, and
`conversation_idle`. Their JSON protocol, failure behavior, and settings are
defined in [`docs/hooks.md`](docs/hooks.md). Built-in idle maintenance may write
or consolidate only private memory; shared knowledge and task maintenance uses
Obsidian during ordinary runtime work.

## Daemon HTTP API

`ghostd` is the only session owner. All `/api/*` routes require the bearer token
from Ghost's mode-0600 XDG-state token file, except explicitly public viewer
assets and authenticated tailnet requests. Loopback CORS allows only the exact
HUD/client methods and headers. Errors are
`{ "error": { "code": string, "message": string } }` with a meaningful HTTP
status. Request bodies and control files are bounded before allocation.

Tailnet identity is accepted only from Tailscale Serve's verified local proxy
boundary. The configured owner has full access; admitted guests are read-only.
Remote access never broadens a ghost's local tool authority.

Route parsing, validation, status codes, and reverse states are executable in
[`server.ts`](packages/daemon/src/server.ts) and
[`server.test.ts`](packages/daemon/test/server.test.ts). Stable route families:

| Route | Contract |
|---|---|
| `GET /api/hooks` | Redacted hook status. |
| `GET\|PUT /api/hooks/config` | Read or atomically replace the admitted `hooks.json`. |
| `GET\|POST /api/ghosts` | List or create ghosts. |
| `PUT /api/ghosts/:name/name` | Rename a ghost and its whole home. |
| `DELETE /api/ghosts/:name?confirm=:name` | Move a ghost home to recoverable Trash. |
| `GET\|PUT\|DELETE /api/ghosts/:name/memory` | List, write, or trash private memory. |
| `GET\|PUT /api/ghosts/:name/model` | Read or set the chat model. |
| `GET /api/ghosts/:name/models` | Paginated available/catalog model rows. |
| `GET\|PUT /api/ghosts/:name/model-routing` | Read or replace role primaries/fallbacks. |
| `GET /api/ghosts/:name/providers` | Login-capable Pi providers and accounts. |
| `POST /api/ghosts/:name/login` and `GET\|POST /login/:id[/input]` | Start, poll, and answer a provider login. |
| `DELETE /api/ghosts/:name/providers/:provider/accounts/:account` | Remove one Ghost-owned Secret Service account item. |
| `GET\|POST\|PUT\|DELETE /api/ghosts/:name/mcp…` | Sanitized MCP catalog, mutation, enablement, reconnect, and isolated test. |
| `POST /api/ghosts/:name/greeting` | `{ greeting: string|null, onboarding }`; generation failure is a null greeting, not a 5xx. |
| `POST /api/ghosts/:name/messages` | One turn as the pi-messages SSE protocol. |
| `GET /api/ghosts/:name/events` | Conversation invalidation SSE; clients refetch affected state. |
| `GET /api/ghosts/:name/sessions` | Runtime-qualified conversation summaries. |
| `GET\|PUT\|DELETE /sessions/:id/project…` | Read, preview, bind/reload/unbind, or abandon an unpublished trusted-project draft. |
| `PUT /sessions/:id/{pin,read,title}` | Mutate owner-visible conversation metadata. |
| `GET /sessions/:id/commands` | Effective Pi slash-command catalog; Claude returns not supported. |
| `POST /sessions/:id/recap` | Non-persisted bounded Pi recap; failure returns `recap:null`. |
| `GET /sessions/:id/jobs` | `{ jobs }` for the open conversation. |
| `POST /sessions/:id/jobs/:jobId/cancel` | `{ outcome, job }`; unknown is 404. |
| `GET /sessions/:id/transcript` | Paged renderable Pi history; Claude history stays native. |
| `GET\|POST /sessions/:id/ask` | Inspect or resolve one pending owner question. |
| `GET\|POST /sessions/:id/queue` | Inspect/enqueue Pi steering or follow-up text. |
| `POST /sessions/:id/branch` | Fork before one persisted Pi user entry. |
| `POST /sessions/:id/reanswer` | Reopen an historical ask result and resume that branch. |
| `DELETE /sessions/:id` | Move every Ghost-owned conversation artifact to Trash. |
| `GET\|POST /sessions/:id/live` | Reserved voice boundary; default is not supported. |
| `GET\|POST /sessions/:id/collab` | Legacy injected-host boundary; Ghost ships no host. |
| `GET /api/remote/whoami` | Effective owner/guest identity. |
| `GET\|POST /api/remote` and `GET /api/remote/qr.svg` | Tailscale Serve status/control and active URL QR. |
| `GET /manifest.webmanifest` | Public viewer manifest. |

There are intentionally no `/plan` or `/todo` session routes.

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

The terminal client is an HTTP client only; it never imports daemon state
modules or edits a ghost home directly. Its command catalog is defined in
[`cli/main.ts`](packages/daemon/src/cli/main.ts). It supports conversation,
ask, job, model, memory, status, and skill operations. There are no plan or todo
commands.

## Models and credentials

`models.json` owns provider policy, exact Secret Service account references,
roles, and retry chains. Credential values never enter that file, logs, API
responses, or ghost-home backups. Inherited provider/auth environment variables
are scrubbed before Pi runtime construction. Claude Code receives a separate
reviewed operational/selector environment captured before the global scrub; its
credential-bearing values are excluded. The implementation allowlists and tests
in [`env-scrub.ts`](packages/daemon/src/env-scrub.ts) and
[`claude-code.ts`](packages/daemon/src/claude-code.ts) are normative.

Roles are `chat_model`, `smol_model`, `slow_model`, `vision_model`,
`plan_model`, `designer_model`, `commit_model`, `tiny_model`, `task_model`, and
`advisor_model`. Each may have an ordered fallback chain where the runtime
supports it. `claude-code/default` is valid only as the primary chat runtime;
it is not a Pi provider model and is never a role fallback.

`chat_model` uses an explicit usable selection or Pi's catalog default.
`smol_model` serves titles, greetings, and trusted command-hook completions. If
unset, it chooses the cheapest usable model, treating an authenticated
subscription as zero marginal cost. An explicit unusable smol binding fails
loudly rather than silently switching models. Conversation titles are one
persisted Pi `session_info` name after the first turn; owner titles win.

Ghosts run unthrottled. Provider, runtime, and context limits surface as typed
errors and use configured runtime retry/fallback behavior; Ghost adds no turn,
hosted-session, concurrency, or spend cap.

## Package boundaries

- [`packages/extensions`](packages/extensions/src/index.ts) is runtime-neutral:
  ghost-home parsing, prompt construction, pure tools, browser/desktop clients,
  and the `extension-api.ts` seam. It imports no daemon or UI.
- [`packages/daemon`](packages/daemon/src/main.ts) owns configuration,
  authentication, sessions, runtime adapters, models, MCP, hooks, lifecycle,
  jobs, HTTP, and the `ghost` CLI. Bun is the production runtime.
- [`packages/shell`](packages/shell/qml/shell.qml) is a Quickshell client. It
  talks only to authenticated HTTP/SSE and never edits durable state directly.
- [`packages/chromium-extension`](packages/chromium-extension/extension) is the
  opt-in MV3 relay into the owner's Chromium. Pairing and workspace ownership
  are capability-scoped; there is no second browser backend.
- [`packages/desktop-helper`](packages/desktop-helper/src/ghost_desktop_helper)
  is the Python JSON-lines computer-use sidecar. Root pnpm commands do not cover
  it.
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
- Home rename/delete, project transitions, MCP mutation, model refresh, live
  voice, collaboration, maintenance, fork, and conversation deletion use
  explicit leases and publish only durable state.
- Control files are bounded, validated, atomically replaced, and fail closed on
  links, malformed bytes, identity changes, ambiguous recovery, or incomplete
  fsync.
- Browser/session/process teardown tracks exact captured owners and PIDs. No
  cleanup may kill by pattern or remove a broad directory.
- Logs redact secrets and private payloads. Journal identity fields are `GHOST`
  and `CONVERSATION`; other structured fields remain in `MESSAGE`.
- Package install/upgrade must not enable Ghost until the desktop owner has the
  official Obsidian CLI registered, `obsidian version` succeeds with the app
  open, and the upstream skill exists at
  `~/.agents/skills/obsidian-cli/SKILL.md`. Root ALPM hooks may only report this
  requirement; issue #54 owns the supported user-level readiness gate.
- Package removal preserves ghost homes, XDG config/state, Secret Service
  items, the Obsidian skill, and all vaults.

Focused tests beside the implementation are part of these contracts. GitHub
issues track unfinished work and release evidence; this file describes the
desired end state, not the backlog.
