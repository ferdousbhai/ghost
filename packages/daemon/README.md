# `@ghost/daemon` — `ghostd`

The local process that hosts Ghost personas behind one authenticated loopback
API. Provider-agnostic conversations run on modern Oh My Pi 18.0.3; selecting
`claude-code/default` uses the owner-local Claude Agent SDK boundary documented
in [`docs/claude-code-runtime.md`](../../docs/claude-code-runtime.md).

## Run it

Ghost's OMP packages require Bun 1.3.14 or newer.

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
      --offline            disable OMP catalogue network refresh
      --log-level <level>  debug | info | warn | error
```

`config.json` carries the same settings plus `browserMode`, `compaction`, and
`askTimeoutSeconds`. Compaction is OMP-native and asynchronously speculative:
`enabled` defaults to true, `thresholdFraction` defaults to `0.8` and maps to
OMP's percentage threshold, and `thresholdTokens` selects a fixed native
threshold and takes precedence when both are present. The last setting is how
long a question waits before it settles
itself — with the option its asker marked recommended, or with no selection
when it marked none — so that a turn nobody is watching resumes instead of
stalling; `0` waits forever. It is daemon-wide rather than per-ghost because how
long a dialog sits is a property of the person at the keyboard, not of the
persona asking, and each session carries it as OMP's own `ask.timeout` so plan
mode and a per-question deadline still win. Every setting also has an
environment override (`GHOSTD_ASK_TIMEOUT` here); see `loadConfig` for the
compaction overrides as well.

The systemd user unit is in `contrib/ghostd.service`. `SIGINT` and `SIGTERM`
stop new requests, end live streams, dispose hosted sessions, and exit cleanly.

## Storage and isolation

Everything Ghost owns for an OMP conversation stays inside the ghost home:

```text
~/ghosts/<name>/
  docs/**/*.md             canonical v2 Markdown documents
  .pi/
    models.json            providers plus Ghost roles/fallbacks
    models.omp.json        generated OMP-compatible provider projection
    models.db              derived OMP catalogue cache
    agent.db               canonical OMP credential store
    auth.json              optional legacy import source; retained after import
    .auth-json-imported-v18 one-time import marker
  .sessions/
    <conversation>.jsonl   OMP session tree
    claude-<sha256>.json   Claude resume metadata, when selected
```

### Documents (`ghost-home/v2`)

`docs/**/*.md` is the canonical document tree. Every document starts at byte 0
with a non-empty level-one ATX heading (`# Title`). Its optional final nonblank
line is a space-separated list made only of lowercase hashtag slugs matching
`#[a-z0-9]+(?:-[a-z0-9]+)*`; `#archived` is reserved and excludes that document
from the default working set. The heading and tag line are ordinary Markdown
and remain in `DocFile.body`. Documents never use YAML frontmatter.

Import and daemon startup perform the one-time `ghost-home/v1` migration after
renaming an unambiguous `notes/` directory to `docs/`. For each legacy file,
the first H1 supplies the title, then legacy frontmatter `title`, then the
filename. Legacy tags become lowercase hyphenated hashtag slugs,
`archived: true` becomes `#archived`, and the import-only `path` field is
discarded. Existing trailing hashtags are merged and deduplicated. Each file
is rewritten atomically and is valid v2 immediately, so a failed scan can be
rerun safely. There is no migration marker and no dual-format reader: after
migration, readers and writers accept v2 only. If both `notes/` and `docs/`
exist, startup fails rather than guessing.

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

`writeDoc(path, { body })` validates the complete canonical Markdown body and
writes exactly that body; there are no separate title, tag, archived, or
application-path write options. Context listings are derived from disk for each
request, report malformed siblings instead of guessing, and never persist a
catalog.

### Project MCP

Ghost deliberately narrows OMP's MCP discovery to the selected home’s
`.omp/mcp.json` and legacy `.omp/.mcp.json`. The management API reads and writes
only those files. Its list response redacts every credential-bearing value and
does not open a conversation merely to report connection status.

Config mutations are live: every idle OMP conversation reconnects from the two
project files and replaces its mounted MCP tools; a busy conversation defers one
coalesced reload until it settles. An explicit test uses an isolated MCP manager
without creating an AgentSession, while reconnect only targets managers that
are already loaded.

### Connect and recoverable deletion

The session-scoped live-voice and collaboration routes deliberately cross the
owner-local boundary. Live voice uses the local microphone and OpenAI Codex
Realtime with the ghost's Codex OAuth. Collaboration exposes distinct encrypted
read-only and confirmed writable relay links; the latter can drive the host
session and its local tools. Links are never logged.

Every user-visible file deletion is a move to freedesktop Trash. This covers
whole ghosts, OMP transcripts, Claude resume sidecars, hosted import sources,
documents, and memory files. Cross-filesystem moves fall back to a hidden
same-filesystem Trash directory. Only rollback of a fork that was never shown
to the owner remains a permanent unlink.

`SessionManager.open` receives the explicit per-ghost session directory;
`createAgentSession({ agentDir })` alone does not redirect transcripts.
Credentials are never inherited from the daemon environment: `env-scrub.ts`
removes provider keys and routing variables before OMP is loaded. Provider
login writes `agent.db`; a previous `.pi/auth.json` is imported once, without
being deleted.

Sessions are trusted local OMP projects. They keep native filesystem,
Bash, skills, rules, project context, plugins, MCP, LSP, task/hub, web search,
and background jobs, then add Ghost's extensions. Tool approval UI is disabled
(`approvalMode: yolo`, `autoApprove: true`); `ask` is not an approval prompt.


## Models and routing

The catalogue and provider authentication come from OMP's `ModelRegistry` and
`AuthStorage`. `models.json` remains Ghost's durable, inspectable policy file:

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

Ghost maps its roles to OMP as follows:

| Ghost | OMP |
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

Fallback arrays are ordered and projected to `retry.fallbackChains`; OMP owns
retry classification, cooldowns, and fallback execution. The switcher orders a
provider's models using OMP's priority and then descending semantic
version/date, so the newest family appears first. `claude-code/default` can be
the primary chat runtime but cannot be an OMP fallback or a non-chat role.
General and Research are compatibility-only rows and appear only when an older
home has configured them.

Interactive provider login is a pollable wrapper around OMP's registry login.
The same flow is available in the shell and in a TTY:

```bash
ghostd login <ghost> --provider openai-codex
ghostd login <ghost> --provider openrouter --api-key
```

The TTY form writes credentials directly into the ghost home, so it also
requires the daemon to be stopped and holds the same root reservation for the
complete login. The shell's login flow already runs inside the serving daemon.

A pasted code or key is resolved directly into the pending login interaction;
it is not logged or returned from a GET response.

## OMP interaction features

The daemon exposes OMP's interaction primitives without translating them into
ad-hoc prompts:

- `ask` pauses the harness on structured questions. The HTTP bridge supports
  submit, chat-about-this, and cancel outcomes; validates all option ids; is
  first-response-wins; and remains pollable across a shell reconnect.
- `steer` injects text into the active generation. `followUp` queues a new turn
  after the current generation. The shell maps Enter/Ctrl+Enter accordingly
  while streaming.
- Tool lifecycle events include start, update, completion, error, bounded
  result summaries, and model-fallback state so the shell can render durable
  activity cards rather than a transient name.
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
| PUT | `/api/ghosts/:name/name` | rename the ghost, moving its whole home |
| GET | `/api/ghosts/:name/context` | derive browsable docs, memory, character, and available task helpers |
| DELETE | `/api/ghosts/:name/context` | move one confirmed docs/memory file to Trash |
| GET/POST | `/api/ghosts/:name/mcp` | list or add project-owned MCP servers |
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
OMP is the harness behind it.

## Validate

```bash
pnpm --filter @ghost/daemon typecheck
pnpm --filter @ghost/daemon build
pnpm --filter @ghost/daemon test
```

Tests use a scripted local provider and real loopback HTTP/SSE. They never call
a paid model.
