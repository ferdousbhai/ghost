# `@ghost/daemon` — `ghostd`

The local process that hosts Ghost personas behind one authenticated loopback
API. Provider-agnostic conversations run on pi (`@earendil-works/pi-coding-agent`,
`pi-agent-core`, and `pi-ai` 0.84.3); selecting
`claude-code/default` uses the owner-local Claude Agent SDK boundary documented
in [`docs/claude-code-runtime.md`](../../docs/claude-code-runtime.md).

## Run it

Ghost runs on Bun 1.3.14 or newer (`bun --bun`). `pnpm --filter @ghost/daemon
build:binary` compiles `ghostd` into one self-contained executable
(`packages/daemon/dist/ghostd`, Bun runtime included, version embedded); it
needs no `node_modules` at runtime. Playwright's optional BiDi/Electron
modules and macOS `fsevents` are left external because Ghost drives Chromium
over CDP and never loads them. Packaging still installs the source tree; the
binary becomes the package artifact in a follow-up (issue #17).

```bash
pnpm --filter @ghost/extensions build
pnpm --filter @ghost/daemon build
bun packages/daemon/dist/main.js

# development
bun packages/daemon/src/main.ts --port 7788
```

```text
ghostd [options]

  -p, --port <port>        port on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  directory containing ghosts
      --config <file>      default ~/.config/ghost/config.json
      --offline            disable pi catalogue network refresh
      --log-level <level>  debug | info | warn | error
```

`config.json` carries the same settings plus `browserMode`, `compaction`, and
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

## Storage and isolation

Everything Ghost owns for a pi conversation stays inside the ghost home:

```text
~/ghosts/<name>/
  character.md             persona
  memory/*.md              one durable fact per plain Markdown file
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

The HTTP API browses one directory at a time with opaque pagination and current-
directory name filtering. It never follows symbolic links. Its inline content
route opens a regular file below pinned directory descriptors, reads at most
1 MiB of strict UTF-8 text, and rejects NUL, replacement, and special-file
swaps; the shell does not read Documents pathnames itself. File deletion is
descriptor-confined, serialized through the shared filesystem lock, and moves
one exactly confirmed regular file to recoverable Trash. Ghost rename, delete,
and future home export never move or copy the owner-wide Documents tree.

The hosted importer retains its bounded archive safety and may leave legacy
`notes/`/`docs/` Markdown under the imported ghost home for explicit manual
placement. That compatibility tree is not indexed or exposed as live Documents;
there is no automatic startup/import migration into the owner's XDG directory.

To retain those files, stop Ghost and choose one legacy home. The source is
normally `<ghost-home>/docs` after hosted import compatibility has run; use the
exact `root` reported by `GET /api/documents`. The operator command defaults to
a read-only dry run:

```bash
ghostd place-legacy-documents \
  --source /absolute/path/to/ghost-home/docs \
  --documents-root /absolute/path/from-api
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
  --documents-root /absolute/path/from-api \
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

Ghost-home context listings are derived from disk for each request and never
persist a catalog. Documents use their separate machine-level route.

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

The session-scoped live-voice and collaboration routes deliberately cross the
owner-local boundary. Their daemon API and interfaces (`LiveVoiceManager`,
`CollaborationManager`) are in place, but the default implementations answer
`501 not_supported` until the Ghost-owned ports land (issue #3).

Whole ghosts, documents, and memory files move to freedesktop Trash, with a
same-filesystem fallback when needed. Conversation deletion pre-journals every
owned transcript/sidecar destination inside a private same-filesystem fallback
Trash root so a crash after rename can recover the complete receipt. Only
rollback of a fork or project draft that was never shown to the owner remains a
permanent unlink.

`SessionManager.open` receives the explicit transcript file, per-ghost session
directory, and cwd, so nothing lands in `~/.pi`.
Credentials are never inherited from the daemon environment: `env-scrub.ts`
removes provider keys and routing variables before a session is created.
Provider login writes Ghost's Linux Secret Service schema at machine scope.
Portable config contains only service/account references; see
[`docs/keyring.md`](../../docs/keyring.md). Legacy plaintext `.pi/auth.json`
(and an older home's `agent.db` credential rows) are verified into Secret
Service and then scrubbed.

New sessions start with the owner's home as their operational cwd, while
transcripts, persona, memory, browser state, configuration, and keyring policy
remain under the ghost home. Credentials are machine-wide service/account
items. The cwd alone grants no discovery authority. A
conversation may explicitly trust and bind one project, after which Ghost pins
its data-only instructions, skills, rules, Markdown commands/prompts, and scoped
MCP configuration. Project executable extensions, hooks, custom code tools,
LSP, and custom agent definitions stay disabled until they can run through an
isolated per-session boundary. A pi session has no `task` tool, so no
bundled, project, ghost-file, or ambient subagent is invokable in phase 1.
pi's native `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` plus
Ghost's own tools (registered directly as pi custom tools) remain available;
Ghost's own `bash`/`jobs` (background jobs), `web_search`, and
`inspect_image` (the `vision_model` role describes an image a blind chat model
cannot see) join them. There is no tool approval; `ask` is not an approval
prompt.

Claude Code sessions retain Claude's native subagents.


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
not make any subagent available while spawning is disabled in phase 1.

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
- `steer` injects text into the active generation. `followUp` queues a new turn
  after the current generation. The shell maps Enter/Ctrl+Enter accordingly
  while streaming.
- Tool lifecycle events include start, update, completion, error, bounded
  result summaries, and model-fallback state so the shell can render durable
  activity cards rather than a transient name.
- `web_search` tries Brave Search, Firecrawl, then DuckDuckGo, skipping a
  provider without its key — so it works keyless out of the box. A
  `keyring:<service>/<account>` reference under `web.search.<provider>.apiKey`
  in `settings.yml` supplies a key; `web.search.providers` orders the chain.
- Background jobs: `bash` with `background: true` starts a command as a job of
  the conversation, and a foreground command that runs longer than the
  auto-background budget (60 s by default) continues as one. The model's `jobs`
  tool and `/jobs` list, wait for, and cancel them; a settled job reports back
  into the conversation as a follow-up turn. `GET …/sessions/:id/jobs` and
  `POST …/sessions/:id/jobs/:jobId/cancel` expose them to the shell.
- Branching off a message forks the conversation: the transcript is copied to a
  new conversation, rewound to just before that message, and its text handed
  back as a draft, leaving the original untouched. Re-answering a historical
  `ask` still commits the revised result as a sibling in place and resumes
  generation there.

## HTTP API

The authoritative route and payload contract is
[`CONTRACTS.md`](../../CONTRACTS.md). The interaction-specific endpoints are:

| method | path | purpose |
|---|---|---|
| GET | `/api/documents` | lazily list one shared Documents directory |
| DELETE | `/api/documents` | move one confirmed regular Documents file to Trash |
| PUT | `/api/ghosts/:name/name` | rename the ghost, moving its whole home |
| GET | `/api/ghosts/:name/context` | derive browsable character and memory; `agents` is an empty compatibility array while Pi subagents remain disabled |
| DELETE | `/api/ghosts/:name/context` | move one confirmed memory file to Trash |
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
| GET/POST | `/api/ghosts/:name/sessions/:id/collab` | inspect or control encrypted relay collaboration |
| GET/POST | `/api/ghosts/:name/sessions/:id/ask` | poll or resolve the active ask |
| GET/POST | `/api/ghosts/:name/sessions/:id/queue` | inspect or enqueue steer/follow-up |
| POST | `/api/ghosts/:name/sessions/:id/branch` | fork the conversation at a message |
| POST | `/api/ghosts/:name/sessions/:id/reanswer` | branch an ask answer and resume via SSE |
| GET/PUT | `/api/ghosts/:name/model-routing` | inspect or mutate role/fallback policy |

Every `/api` route except the deliberately public relay status requires the
machine-local bearer token, rejects non-loopback browser origins, and requires
JSON for POST/PUT. The pi-messages SSE response remains the client wire format;
pi is the harness behind it.

## Validate

```bash
pnpm --filter @ghost/daemon typecheck
pnpm --filter @ghost/daemon build
pnpm --filter @ghost/daemon test
```

Tests use a scripted local provider and real loopback HTTP/SSE. They never call
a paid model.
