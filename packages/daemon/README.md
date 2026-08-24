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

The systemd user unit is in `contrib/ghostd.service`. `SIGINT` and `SIGTERM`
stop new requests, end live streams, dispose hosted sessions, and exit cleanly.

## Storage and isolation

Everything Ghost owns for an OMP conversation stays inside the ghost home:

```text
~/Ghosts/<name>/.pi/
  models.json              providers plus Ghost roles/fallbacks
  models.omp.json          generated OMP-compatible provider projection
  models.db                derived OMP catalogue cache
  agent.db                 canonical OMP credential store
  auth.json                optional legacy import source; retained after import
  .auth-json-imported-v18  one-time import marker
~/Ghosts/<name>/.sessions/
  <conversation>.jsonl     OMP session tree
  claude-<sha256>.json     Claude resume metadata, when selected
```

`SessionManager.open` receives the explicit per-ghost session directory;
`createAgentSession({ agentDir })` alone does not redirect transcripts.
Credentials are never inherited from the daemon environment: `env-scrub.ts`
removes provider keys and routing variables before OMP is loaded. Provider
login writes `agent.db`; a previous `.pi/auth.json` is imported once, without
being deleted.

Creator sessions are trusted local OMP projects. They keep native filesystem,
Bash, skills, rules, project context, plugins, MCP, LSP, task/hub, web search,
and background jobs, then add Ghost's scoped extensions. Visitor sessions
disable that native discovery/tool surface and expose only publication-aware
docs/memory tools plus OMP's `ask`. Tool approval UI is disabled
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
| `vision_model` | `vision` |
| `smol_model` | `smol` |
| `general_purpose_model` | `general` |
| `research_model` | `research` |

Fallback arrays are ordered and projected to `retry.fallbackChains`; OMP owns
retry classification, cooldowns, and fallback execution. The switcher orders a
provider's models using OMP's priority and then descending semantic
version/date, so the newest family appears first. `claude-code/default` can be
the primary chat runtime but cannot be an OMP fallback or a non-chat role.

Interactive provider login is a pollable wrapper around OMP's registry login.
The same flow is available in the shell and in a TTY:

```bash
ghostd login <ghost> --provider openai-codex
ghostd login <ghost> --provider openrouter --api-key
```

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
- OMP's session tree backs editable branching, sibling navigation, and
  re-answering a historical `ask`; the revised result is committed as a sibling
  and generation resumes on that branch.

## HTTP API

The authoritative route and payload contract is
[`CONTRACTS.md`](../../CONTRACTS.md). The interaction-specific endpoints are:

| method | path | purpose |
|---|---|---|
| DELETE | `/api/ghosts/:name/sessions/:id` | permanently delete an idle conversation |
| GET/POST | `/api/ghosts/:name/sessions/:id/ask` | poll or resolve the active ask |
| GET/POST | `/api/ghosts/:name/sessions/:id/queue` | inspect or enqueue steer/follow-up |
| POST | `/api/ghosts/:name/sessions/:id/branch` | rewind or navigate the session tree |
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
