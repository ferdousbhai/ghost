# `@ghost/daemon` — `ghostd`

The local process that hosts Ghost personas behind one authenticated loopback
API. Provider-agnostic conversations run on pi (`@earendil-works/pi-coding-agent`,
`pi-agent-core`, and `pi-ai` 0.84.3); selecting
`claude-code/default` uses the owner-local Claude Agent SDK boundary documented
in [`docs/claude-code-runtime.md`](../../docs/claude-code-runtime.md).

## Run it

Ghost runs on Bun 1.3.14 or newer. `pnpm --filter @ghost/daemon build:runtime`
bundles `ghostd`, its `ghost` terminal client, and their Ghost/pi/provider
application closure plus required static assets into
`packages/daemon/dist/runtime`. The launchers use the
system `/usr/bin/bun`; no `node_modules` or daemon source tree is installed.
macOS `fsevents` and the optional owner-installed Claude Agent SDK are left
external. The exact owner-installed Claude harness boundary is documented in
[`docs/claude-code-runtime.md`](../../docs/claude-code-runtime.md).

```bash
# development
bun packages/daemon/src/main.ts --port 7788

# built bundle, using an explicit test/development Bun path
GHOST_BUN_EXECUTABLE="$(command -v bun)" \
  packages/daemon/dist/runtime/bin/ghostd --port 7788
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
ghost delegation
ghost smoke --no-turn
ghost smoke --model claude-code/default
```

`ghost delegation` is the one local read-only client command: it inspects the
installed Pi, Codex, and Claude Code harnesses without contacting ghostd or
opening a ghost home. It reports availability/authentication only; delegated
task mutation remains inside an authenticated Ghost conversation/API.

`ghost smoke` starts a scratch daemon and a scratch ghost. `--no-turn` is the
package/CI startup proof. A real smoke can select a runtime with `--model`; it
checks three turns in one conversation, readable memory output, and persisted
message accounting. Pi providers need credentials available to the scratch
ghost, while `claude-code/default` uses the owner's external Claude Code
authentication.

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
stop new requests, end live streams, dispose cached sessions, and exit cleanly.
Filter one ghost's journal records with
`journalctl --user -u ghostd GHOST=<name>`; see the
[daemon harness invariants](../../CONTRACTS.md#daemon-harness-invariants) for
the structured field contract.

## Storage and isolation

Everything Ghost owns for a pi conversation stays inside the ghost home:

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
  .trash/                  recoverable per-home deletion state
  .memory-maintenance.json last consolidation claim time
```

### Owner-wide Documents

Live documents are the owner's XDG Documents tree, not per-ghost state. Ghost
resolves `XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`; every
ghost shares that one root. Files may have any type and folders may nest to any
depth or width. A model's automatic index contains only the root's immediate
non-hidden regular files and directories, with no content reads or descent,
capped at 50 newest-modified entries and 4,000 characters. Explicit native
filesystem tools can traverse further when the task calls for it.

Ghost rename, delete, and future home export never move or copy the owner-wide
Documents tree.

An older local install may still have a per-ghost `notes/` or `docs/` tree.
Ghost leaves that tree byte-for-byte untouched: it is neither indexed as live
Documents nor moved automatically. To retain it in the owner-wide tree, choose
the exact source and the absolute Documents root (`XDG_DOCUMENTS_DIR`, the
configured XDG user directory, or `~/Documents`). The standalone owner command
defaults to a read-only dry run:

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
tree; matching relative paths collide and require an owner-chosen name rather
than an automatic namespace. The command does not open, rewrite, or reserve a
ghost home. It is an explicit local-owner operation, never a daemon startup
migration.

Ghost-home context listings and the owner-wide Documents index are derived from
disk and never persist a catalog.

The memory index is likewise derived newest-modified first, once when a session
starts, with at most 50 entries and 4,000 characters. After a settled turn has
been idle for 60 seconds, ordinary maintenance may write one owner-grounded
fact. Reaching 50 valid memory files switches that delivery to consolidation,
limited to four writes and four recoverable `.trash/` deletions with a ten-hour
claimed cooldown. Foreground turns get no deletion tool and write through the
runtime's native filesystem tools; the prompt carries the filename and hard
limits of 2,000 JavaScript UTF-16 code units and 6,001 on-disk bytes, but those
native writes do not pass through GhostHome validation or redaction. HUD and
background writers do, and redact common secret forms before validation, slug
derivation, or disk.

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
Trash root so a crash after rename can recover the complete receipt. Terminal
delegated-task records move with that conversation as one count/digest-bound
private group; active workers return `409 tasks_active` before deletion changes
anything, so the owner can cancel or wait and retry. Only
rollback of a fork or project draft that was never shown to the owner remains a
permanent unlink.

All delegated-task reads and mutations share one runtime-qualified parent lane
with fork, draft-abandon, and delete lifecycle operations. HTTP task access
requires the exact durable Pi transcript or Claude sidecar; only the private
principal bridge may delegate during its still-active first owner turn before
publication. Draft abandonment requires no task history in any state; finished
worker history moves only with full conversation deletion. Home moves close and
drain controller operations before native shutdown and store closure.

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
Ghost's five durable task tools for native Pi, Codex, and Claude Code coding
workers; those workers revalidate the conversation's exact trusted project and
receive no Ghost-injected bundled or ghost-file subagent definitions. Their
native project discovery remains intact; delegated Claude may additionally
receive one optional opaque native agent name.
Each worker and its ordinary descendants are owned by one collected transient
systemd user scope derived from the durable task id. A random receipt is stored
with the task before launch and must match the scope's exact Description before
Ghost may stop it. Completion, cancellation, restart recovery, and daemon
shutdown remain nonterminal until that receipt-bound scope is confirmed
inactive or safely absent after registration settles; user-manager failures
never become synthetic success. The scope is lifecycle ownership, not a
sandbox: a trusted harness that deliberately creates another systemd unit, or
the same owner deliberately tampering with Ghost's reserved scope names, can
escape this boundary. Native packages require systemd 254 or newer.
pi's native `bash`, `edit`, `find`, `grep`, `ls`, `read`, and `write` plus
Ghost's own tools (registered directly as pi custom tools) remain available;
Ghost's own `bash`/`jobs` (background jobs) and `inspect_image` (the
`vision_model` role describes an image a blind chat model cannot see) join
them. There is no tool approval; `ask` is not an approval prompt.

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
and `commit_model` stay unset until bound. `task_model` and `advisor_model`
remain model-routing roles: they do not select a native harness or activate a
project/ghost agent definition. Native task creation chooses Pi, Codex, or
Claude Code explicitly at the durable delegation boundary.

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
- Recap runs one non-persisted completion over an existing Pi conversation's
  effective system prompt and current branch. It uses the current chat model
  but never appends its prompt or reply to the transcript. The request is
  abortable and presentation-only; Claude Code has no equivalent non-mutating
  conversation context.
- Pi plan mode (`POST …/sessions/:id/plan {action: start}`) exposes only native
  file reads/search, structured observation, and `propose_plan`; model Bash,
  generic writes, screenshots, and state-changing tool actions are blocked.
  Starting is refused until the owner settles any running background jobs; it
  never cancels them. Approval through `ask` ends planning and pins the plan into
  every later turn. The `todo` tool is view-only while planning; `/todo` keeps a
  phased task list the shell can show (`GET …/sessions/:id/todo`). Claude Code
  conversations do not support this Ghost-owned mode.
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
- Branching off a message forks the conversation: the transcript is copied to a
  new conversation, rewound to just before that message, and its text handed
  back as a draft, leaving the original untouched. Re-answering a historical
  `ask` still commits the revised result as a sibling in place and resumes
  generation there.

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
| GET | `/api/ghosts/:name/events` | stream conversation-list invalidations until disconnect or a whole-home move |
| GET/PUT | `/api/ghosts/:name/memory` | list or write the ghost's plain memory files |
| DELETE | `/api/ghosts/:name/memory` | move one confirmed memory file to Trash |
| GET/PUT | `/api/ghosts/:name/sessions/:id/project` | inspect, bind, or unbind one conversation project |
| POST | `/api/ghosts/:name/sessions/:id/project/preview` | inspect a project and mint a short-lived trust receipt |
| POST | `/api/ghosts/:name/sessions/:id/project/reload` | refresh an idle conversation's trusted snapshot |
| DELETE | `/api/ghosts/:name/sessions/:id/project/draft` | abandon an unpublished pre-turn project draft |
| GET/POST | `/api/ghosts/:name/sessions/:id/tasks` | list or create delegated coding tasks for a published runtime-qualified parent |
| GET | `/api/ghosts/:name/sessions/:id/tasks/:taskId` | inspect one bounded delegated-task projection |
| POST | `/api/ghosts/:name/sessions/:id/tasks/:taskId/send` | follow up while a delegated task is running |
| POST | `/api/ghosts/:name/sessions/:id/tasks/:taskId/cancel` | cancel and wait for confirmed native quiescence |
| GET/POST | `/api/ghosts/:name/mcp` | list or add ghost-owned MCP servers |
| PUT/DELETE | `/api/ghosts/:name/mcp/:server` | replace or remove one MCP server |
| PUT | `/api/ghosts/:name/mcp/:server/enabled` | enable or disable one MCP server |
| POST | `/api/ghosts/:name/mcp/:server/test` | isolated sanitized connection probe |
| POST | `/api/ghosts/:name/mcp/:server/reconnect` | retry already-loaded live managers |
| PUT | `/api/ghosts/:name/sessions/:id/title` | rename one conversation |
| POST | `/api/ghosts/:name/sessions/:id/recap` | generate a transient Pi recap |
| DELETE | `/api/ghosts/:name/sessions/:id` | move every owned conversation artifact to Trash |
| GET/POST | `/api/ghosts/:name/sessions/:id/live` | inspect or control realtime voice |
| GET/POST | `/api/ghosts/:name/sessions/:id/collab` | unsupported legacy collaboration compatibility seam |
| GET/POST | `/api/ghosts/:name/sessions/:id/ask` | poll or resolve the active ask |
| GET/POST | `/api/ghosts/:name/sessions/:id/queue` | inspect or enqueue steer/follow-up |
| POST | `/api/ghosts/:name/sessions/:id/branch` | fork the conversation at a message |
| POST | `/api/ghosts/:name/sessions/:id/reanswer` | branch an ask answer and resume via SSE |
| GET/PUT | `/api/ghosts/:name/model-routing` | inspect or mutate role/fallback policy |

Every `/api` route except the deliberately public relay status requires the
machine-local bearer token, rejects non-loopback browser origins, and requires
JSON for POST/PUT. The pi-messages SSE response remains the client wire format;
pi is the harness behind it. A rename or delete closes the old-name event
stream; reconnect a renamed ghost at its new name.

## Validate

```bash
pnpm --filter @ghost/daemon typecheck
pnpm --filter @ghost/daemon build
pnpm --filter @ghost/daemon test
```

Tests use a scripted local provider and real loopback HTTP/SSE. They never call
a paid model.
