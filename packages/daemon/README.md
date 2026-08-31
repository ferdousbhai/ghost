# `@ghost/daemon` — `ghostd`

The local process that hosts Ghost personas behind one authenticated loopback
API. Provider-agnostic conversations run on pi (`@earendil-works/pi-coding-agent`,
`pi-agent-core`, and `pi-ai` 0.84.3); selecting
`claude-code/default` uses the owner-local Claude Agent SDK boundary documented
in [`docs/claude-code-runtime.md`](../../docs/claude-code-runtime.md).

## Run it

Ghost runs on Bun 1.3.14 or newer (`bun --bun`). `pnpm --filter @ghost/daemon
build:binary` compiles `ghostd` and its `ghost` terminal client into
self-contained executables (`packages/daemon/dist/ghostd` and `dist/ghost`, Bun
runtime included, version embedded); they need no `node_modules` at runtime.
macOS `fsevents` is left external because Ghost never loads it. The Arch development package installs this
artifact directly as `/usr/bin/ghostd`; it does not install the daemon source
tree or JavaScript dependencies.

```bash
# development
bun packages/daemon/src/main.ts --port 7788

# built binary
packages/daemon/dist/ghostd --port 7788
```

```text
ghostd [options]

  -p, --port <port>        port on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  directory containing ghosts
      --config <file>      default ~/.config/ghost/config.json
      --offline            disable pi catalogue network refresh
      --log-level <level>  debug | info | warn | error
```

## Terminal client

The implementation in `src/cli/` follows the authoritative
[`ghost` CLI contract](../../CONTRACTS.md#ghost-cli).

```sh
ghost say "Summarize what we were doing"
ghost sessions
ghost show -s cli-abc
ghost ask -s cli-abc
ghost watch
ghost smoke --no-turn
```

`ghost smoke` starts a scratch daemon and a scratch ghost. A real turn needs a
provider signed in inside that scratch home, so CI uses `--no-turn`.

`config.json` carries the same settings plus `compaction` and
`askTimeoutSeconds`. Compaction is pi's native compaction: `enabled` defaults
to true, `thresholdFraction` defaults to `0.8`, and `thresholdTokens` selects a
fixed threshold and takes precedence when both are present; Ghost projects the
threshold onto pi's `reserveTokens` for the bound model's context window and
supplies its own summary instructions. The last setting is how
long a question waits before it settles
itself — with the option its asker marked recommended, or with no selection
when it marked none — so that a turn nobody is watching resumes instead of
stalling; `0` waits forever. It is daemon-wide rather than per-ghost because how
long a dialog sits is a property of the person at the keyboard, not of the
persona asking, and Ghost's own `ask` tool hands it to each question so plan
mode and a per-question deadline still win. Every setting also has an
environment override (`GHOSTD_ASK_TIMEOUT` here); see `loadConfig` for the
compaction overrides as well.

The systemd user unit is in `contrib/ghostd.service`. `SIGINT` and `SIGTERM`
stop new requests, end live streams, dispose hosted sessions, and exit cleanly.
Filter one ghost's journal records with
`journalctl --user -u ghostd GHOST=<name>`; see the
[daemon harness invariants](../../CONTRACTS.md#daemon-harness-invariants) for
the structured field contract.

## Storage and isolation

Ghost-owned persona state and Pi principal transcripts stay inside the ghost
home. Durable normalized task records are per-ghost there too. Linked task
worktrees deliberately live under `$XDG_STATE_HOME/ghost/task-worktrees/`,
while installed native harnesses retain
their full transcripts in their native stores:

```text
~/ghosts/<name>/
  character.md             persona
  memory/*.md              one stable fact per plain Markdown file
  settings.yml             the ghost's own plain YAML settings
  models.json              providers, keyring policy, roles, and fallbacks;
                           secret references only
  mcp.json                 ghost-owned MCP servers; secret references only
  .pi/                     derived pi machine runtime; never credentials
    models.pi.json         secret-free provider/models view synced from
                           models.json
    models-store.json      pi's catalogue cache
  sessions/
    <conversation>.jsonl   pi session file
    claude-<sha256>.json   Claude resume metadata, when selected
    <stem>.<runtime>.project.json
                           conversation project root, cwd, and snapshot status
    <stem>.pi.project-snapshot.<generation>.json
                           immutable accepted Pi project resources
    <stem>.pi.tool-cwds.json
                           execution cwd for persisted Pi tool calls
    <stem>.<runtime>.maintenance.json
                           durable idle-maintenance state
  .tasks/
    task-<uuid>.json       bounded task/workspace state and event tail
  .trash/                  recoverable per-home deletion state
  .memory-maintenance.json last consolidation claim time
```

### Owner-wide Documents

Live documents are the owner's XDG Documents tree, not per-ghost state. Ghost
resolves `XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`; every
ghost shares that one root. Files may have any type and folders may nest to any
depth or width. A model's automatic index contains only the root's immediate
non-hidden regular files and directories, with no content reads or descent,
capped at 100 entries and 4,000 characters. Explicit native filesystem tools
can traverse further when the task calls for it.

Ghost rename, delete, and future home export never move or copy the owner-wide
Documents tree.

The hosted importer retains its bounded archive safety and may leave legacy
`notes/`/`docs/` Markdown under the imported ghost home for explicit manual
placement. That compatibility tree is not indexed or exposed as live Documents;
there is no automatic startup/import migration into the owner's XDG directory.

To retain those files, stop Ghost and choose one legacy home. The source is
normally `<ghost-home>/docs` after hosted import compatibility has run. Pass the
absolute owner-wide Documents root (`XDG_DOCUMENTS_DIR`, the configured XDG
user directory, or `~/Documents`). The operator command defaults to a read-only
dry run:

```bash
ghostd place-legacy-documents \
  --source /absolute/path/to/ghost-home/docs \
  --documents-root /absolute/path/to/Documents
```

It refuses relative paths, symbolic links in either root or any traversed
component, special source files, overlapping roots, and every destination
collision. Review a clean plan, then repeat the exact command with `--apply`.
Apply copies through pinned directory descriptors, publishes with no-overwrite
hard links, preserves each regular file's mode and timestamps, verifies the
published inode, and rolls the whole invocation back on failure. No legacy
source file is modified or removed:

```bash
ghostd place-legacy-documents \
  --source /absolute/path/to/ghost-home/docs \
  --documents-root /absolute/path/to/Documents \
  --apply
```

Never delete the legacy source until the resulting Documents files have been
independently inspected and backed up. Repeat separately for another retained
home; matching relative paths collide and require an owner-chosen name rather
than an automatic namespace. This is an explicit operator tool, never an
automatic startup/import migration.

`ghostd import` requires the daemon to be stopped. The command and daemon take
the same root-keyed filesystem reservation before accessing a ghost home. The
daemon holds it until shutdown; the import holds it through archive publication
and conversation activation. This refuses a live daemon, a daemon startup
racing the import, and concurrent imports even when their host or port settings
differ. Stop the packaged service with
`systemctl --user stop ghostd.service`, run the import, then start it again.
The import's `--host` and `--port` options retain a listener check for older
daemon versions that do not take the root reservation; they must match that
older daemon's effective loopback listener.

Ghost-home context listings and the owner-wide Documents index are derived from
disk and never persist a catalog.

The memory index is likewise derived, newest modification first, before each
model turn. After a settled turn has been idle for 60 seconds, ordinary
maintenance may write one owner-grounded fact. Only index pressure switches
that delivery to consolidation: at least 3,200 of 4,000 index characters, any
omitted memory, or 100 valid files. Consolidation is limited to four writes and
four recoverable `.trash/` deletions and has a six-hour claimed cooldown.
Foreground turns get no deletion tool. Every write path redacts common secret
forms before validation, slug derivation, or disk.

### Ghost and conversation-project MCP

Ghost's own `GhostMcpManager` connects only the ghost home's visible
`mcp.json`, plus `.omp/mcp.json` and legacy `.omp/.mcp.json` under one
explicitly trusted conversation project. The ghost MCP management API reads and
writes only the visible ghost-owned file. Its list response redacts every credential-
bearing value and does not open a conversation merely to report connection
status.

Ghost MCP mutations are live: every idle pi conversation reconnects from the
visible ghost file while reusing the exact project MCP rows admitted with that
conversation's immutable declarative snapshot. It connects a candidate manager
before replacing the mounted MCP tools; a busy conversation defers one
coalesced reload until it settles. Explicit project reload validates and
publishes a new snapshot before the old session is closed and reopened. A bound
project's failures are retained as explicit degraded state. Reconnect only
targets managers that are already loaded.

### Connect and recoverable deletion

The session-scoped live-voice route deliberately crosses the owner-local
boundary; its daemon API and `LiveVoiceManager` interface remain reserved, and
the default implementation answers `501 not_supported`. The legacy
`CollaborationManager` compatibility seam also remains unsupported, but no
encrypted relay is planned. Remote sharing uses the built-in Tailscale viewer.

Whole ghosts and memory files move to freedesktop Trash, with a
same-filesystem fallback when needed. Conversation deletion pre-journals every
owned transcript/sidecar destination inside a private same-filesystem fallback
Trash root so a crash after rename can recover the complete receipt. Only
upgrade recovery of an incomplete legacy fork, or rollback of a project draft
that was never shown to the owner, remains a permanent unlink.

`SessionManager.open` receives the explicit transcript file, per-ghost session
directory, and cwd, so nothing lands in `~/.pi`.
Credentials are never inherited from the daemon environment: `env-scrub.ts`
removes provider keys and routing variables before a session is created.
Provider login writes Ghost's Linux Secret Service schema at machine scope.
Portable config contains only service/account references; see
[`docs/keyring.md`](../../docs/keyring.md). Fetched page and on-screen
text is fenced and screened; see
[`docs/injection-defense.md`](../../docs/injection-defense.md). Legacy plaintext `.pi/auth.json`
(and an older home's `agent.db` credential rows) are verified into Secret
Service and then scrubbed.

New sessions start with the owner's home as their operational cwd, while
transcripts, persona, memory, configuration, and keyring policy remain under the
ghost home; browser state is the owner's, in their own Chromium profile. Credentials are machine-wide service/account
items. The cwd alone grants no discovery authority. A
conversation may explicitly trust and bind one project, after which Ghost pins
its data-only instructions, skills, rules, Markdown commands/prompts, and scoped
MCP configuration. Project executable extensions, hooks, custom code tools,
LSP, and custom agent definitions stay disabled. Both principal runtimes expose
daemon-owned `task`, `task_list`, `task_get`, `task_send`, and `task_cancel`
controls for the native `claude-code`, `codex`, and `pi`
harnesses; project, ghost-file, and ambient agent definitions remain inert in
the principal. The stable `# Delegation` prompt section explains that surface;
the Ghost runs the local `ghost delegation` command through Bash only when it
needs current harness availability, a compact projection of Claude/Codex
Omarchy limits, or native Claude agent names/models for the current cwd. Agent
descriptions and definitions stay inside Claude Code. A task may select one of
those native agents only for Claude Code; Codex and Pi receive the assignment
unchanged through their default agents.
Clean committed Git projects use one daemon-managed linked worktree and local
review branch per task. Task views distinguish the trusted source `root`/`cwd`
from the execution `workspace`; Ghost preserves uncertain work and never
pushes, opens a pull request, or merges implicitly. Non-Git projects run in
place with an explicit notice. See
[`docs/native-harnesses.md`](../../docs/native-harnesses.md#task-workspaces-and-review).
Pi supplies its native `edit`, `find`, `grep`, `ls`, `read`, and `write` tools
alongside Ghost's custom tools. Ghost replaces pi's `bash` by name with its
job-aware `bash`; `jobs` for background work and `inspect_image` (the
`vision_model` role describes an image a blind chat model cannot see) join that
active tool set. There is no tool approval; `ask` is not an approval prompt.

A Claude principal keeps the native tool preset but uses Ghost's complete
custom identity prompt and disables native `Agent`/legacy `Task`; a delegated
Claude task retains Claude Code's native subagents and configuration.


## Models and routing

The catalogue comes from pi (`@earendil-works/pi-ai`, cached in
`.pi/models-store.json`) and provider authentication from pi's `ModelRuntime`
over Ghost's `GhostPiCredentialStore`. `models.json` remains Ghost's durable,
inspectable policy file:

```jsonc
{
  "providers": {},
  "roles": {
    "chat_model": { "provider": "openai-codex", "modelId": "gpt-5.6-sol" },
    "vision_model": { "provider": "openai-codex", "modelId": "gpt-5.6" }
  },
  "fallbacks": {
    "chat_model": [
      { "provider": "openai-codex", "modelId": "gpt-5.6-terra" }
    ]
  }
}
```

Model roles are Ghost-owned. Each role's short name (the `ompRole` field of
the routing API) is:

| Ghost | short name |
|---|---|
| `chat_model` | `default` |
| `smol_model` | `smol` |
| `slow_model` | `slow` |
| `vision_model` | `vision` |
| `plan_model` | `plan` |
| `designer_model` | `designer` |
| `commit_model` | `commit` |
| `tiny_model` | `tiny` |
| `task_model` | `task` |
| `advisor_model` | `advisor` |
| `general_purpose_model` | `general` |
| `research_model` | `research` |

`chat_model` is explicit or the catalogue default (the first catalogue
provider's best-ranked model). `task_model`, `smol_model`, `slow_model`, and
`designer_model` inherit the chat default when unbound; `tiny_model` and
`advisor_model` follow Ghost's preference lists; `vision_model`, `plan_model`,
and `commit_model` stay unset until bound. `task_model` and `advisor_model` do
not select a coding harness or create a durable task; harness choice belongs to
the principal's explicit `task` call.

Fallback arrays are ordered Ghost policy stored in `models.json`. The switcher
orders a provider's models using provider priority and then descending
semantic version/date, so the newest family appears first.
`claude-code/default` can be the primary chat runtime but cannot be a fallback
or a non-chat role. General and Research are compatibility-only rows and appear
only when an older home has configured them.

Interactive provider login is a pollable wrapper around pi's
`ModelRuntime.login`/`logout`. The same flow is available in the shell and in a
TTY:

```bash
ghostd login <ghost> --provider openai-codex
ghostd login <ghost> --provider openrouter --api-key
```

The TTY form writes credentials through Ghost's Secret Service boundary. It
still requires the daemon to be stopped and holds the same root reservation for
the complete login. The shell's login flow already runs inside the serving daemon.

A pasted code or key is resolved directly into the pending login interaction;
it is not logged or returned from a GET response.

## Interaction features

The daemon exposes these interaction primitives without translating them into
ad-hoc prompts:

- Ghost's own `ask` tool pauses the harness on structured questions. The HTTP bridge supports
  submit, chat-about-this, and cancel outcomes; validates all option ids; is
  first-response-wins; and remains pollable across a shell reconnect.
- Principal conversations have no owner-facing mid-turn queue. Stop the active
  turn before sending another message; the stop route waits for runtime,
  persistence, and hook settlement before acknowledging it.
- Tool lifecycle events include start, update, completion, error, bounded
  result summaries, and model-fallback state so the shell can render durable
  activity cards rather than a transient name.
- Ghost has no principal plan mode or model-owned todo list. Planning happens
  in ordinary conversation or as a read-only native harness assignment;
  durable implementation work uses the task lifecycle below.
- Coding delegation is asynchronous and durable. `task_list` and `task_get`
  remain observational, while `task`, `task_send`, and `task_cancel` mutate one
  durable harness task.
- Pi can use Firecrawl, HEY, Basecamp, Obsidian, Google Workspace, and other
  CLI skills through `bash` when the owner installs them. At session
  construction, Ghost uses pi's native parser to snapshot every valid skill
  visible under `~/.agents/skills/` and `~/.pi/agent/skills/`, including
  symlinked entries. There is no hardcoded skill-name allowlist.
- Background jobs: `bash` with `background: true` starts a command as a job of
  the conversation, and a foreground command that runs longer than the
  auto-background budget (60 s by default) continues as one. The model's `jobs`
  tool and `/jobs` list, wait for, and cancel them; a settled job reports back
  into the conversation as a follow-up turn. `GET …/sessions/:id/jobs` and
  `POST …/sessions/:id/jobs/:jobId/cancel` expose them to the shell.
- Ghost exposes no principal conversation-tree controls. Pi retains its native
  entry graph privately for resume, while old pending fork markers are handled
  only by the daemon's upgrade-recovery path.

## Reach it from your phone (Tailscale)

Omarchy ships Tailscale. On the machine running ghostd, turn on Ghost's
tailnet viewer:

```sh
ghostd remote on
```

It prints the URL to open from any device on your tailnet. The built-in viewer
shows your ghosts and conversations live and lets the owner type. The shell
will offer the same switch. `ghostd remote status` shows the URL, owner, guest
policy, and any action needed; `ghostd remote off` removes Ghost's Serve
listener.

Tailscale stamps your identity on each request; the
login this node is signed in as owns the ghosts (set `remote.owner` in
`~/.config/ghost/config.json` to change it), other tailnet members get a
read-only view (`remote.guests: "none"` hides it from them), and ghostd itself
stays bound to loopback. Ghost uses HTTPS when the tailnet has certificates
enabled and otherwise uses HTTP on port 80. An `operator_required` problem
line means to run `sudo tailscale set --operator=$USER` once (Omarchy's
installer normally already has); `not_logged_in` offers `tailscale up`, and
`tailscale_missing` offers `omarchy-install-service-tailscale`.

## HTTP API

The authoritative route and payload contract is
[`CONTRACTS.md`](../../CONTRACTS.md). The interaction-specific endpoints are:

| method | path | purpose |
|---|---|---|
| PUT | `/api/ghosts/:name/name` | rename the ghost, moving its whole home |
| GET/PUT | `/api/ghosts/:name/memory` | list or write the ghost's plain memory files |
| DELETE | `/api/ghosts/:name/memory` | move one confirmed memory file to Trash |
| GET/PUT | `/api/ghosts/:name/sessions/:id/project` | inspect, bind, or unbind one conversation project |
| POST | `/api/ghosts/:name/sessions/:id/project/preview` | inspect a project and mint a short-lived trust receipt |
| POST | `/api/ghosts/:name/sessions/:id/project/reload` | refresh an idle conversation's trusted snapshot |
| DELETE | `/api/ghosts/:name/sessions/:id/project/draft` | abandon an unpublished pre-turn project draft |
| GET/POST | `/api/ghosts/:name/mcp` | list or add ghost-owned MCP servers |
| PUT/DELETE | `/api/ghosts/:name/mcp/:server` | replace or remove one MCP server |
| PUT | `/api/ghosts/:name/mcp/:server/enabled` | enable or disable one MCP server |
| POST | `/api/ghosts/:name/mcp/:server/test` | isolated sanitized connection probe |
| POST | `/api/ghosts/:name/mcp/:server/reconnect` | retry already-loaded live managers |
| PUT | `/api/ghosts/:name/sessions/:id/title` | rename one conversation |
| DELETE | `/api/ghosts/:name/sessions/:id` | move every owned conversation artifact to Trash |
| GET/POST | `/api/ghosts/:name/sessions/:id/live` | inspect or control realtime voice |
| GET/POST | `/api/ghosts/:name/sessions/:id/collab` | unsupported legacy collaboration compatibility seam |
| GET/POST | `/api/ghosts/:name/sessions/:id/ask` | poll or resolve the active ask |
| POST | `/api/ghosts/:name/sessions/:id/stop` | stop a principal turn and await release |
| GET | `/api/ghosts/:name/harnesses` | inspect native-harness availability, auth, and Omarchy usage |
| POST | `/api/ghosts/:name/sessions/:id/tasks` | start a durable coding task attributed to one conversation |
| GET | `/api/ghosts/:name/tasks` | list the ghost's durable coding tasks |
| GET | `/api/ghosts/:name/tasks/:taskId` | inspect one task |
| POST | `/api/ghosts/:name/tasks/:taskId/messages` | steer one task as the owner |
| POST | `/api/ghosts/:name/tasks/:taskId/cancel` | cancel one task |
| GET/PUT | `/api/ghosts/:name/model-routing` | inspect or mutate role/fallback policy |

Every `/api` route except the deliberately public relay status requires the
machine-local bearer token, rejects non-loopback browser origins, and requires
JSON for POST/PUT. The pi-messages SSE response remains the client wire format;
the selected principal harness behind it is either pi or Claude Code.

## Validate

```bash
pnpm --filter @ghost/daemon typecheck
pnpm --filter @ghost/daemon build
pnpm --filter @ghost/daemon test
```

Tests use a scripted local provider and real loopback HTTP/SSE. They never call
a paid model.
