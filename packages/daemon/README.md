# `@ghost/daemon` — `ghostd`

The local process that hosts your ghosts. One `AgentSession` per ghost per
conversation, an HTTP API on `127.0.0.1`, and nothing else: what a ghost *is*
lives in `@ghost/extensions`, and how an agent *runs* is pi's.

## Running it

```bash
pnpm --filter @ghost/extensions build    # daemon depends on its dist/
pnpm --filter @ghost/daemon build
node packages/daemon/dist/main.js        # or: ghostd, once linked

# during development
node --experimental-strip-types packages/daemon/src/main.ts --port 7788
```

```
ghostd [options]

  -p, --port <port>        TCP port to bind on 127.0.0.1 (default 7717)
      --ghosts-root <dir>  Directory holding one sub-directory per ghost
      --config <file>      Config file (default ~/.config/ghost/config.json)
      --offline            Forbid pi's own network calls
      --log-level <level>  debug | info | warn | error
  -h, --help / -v, --version
```

`SIGINT`/`SIGTERM` stop accepting, end live SSE streams, dispose every hosted
session, and exit 0.

### As a service

`contrib/ghostd.service` is a systemd **user** unit using `%h` paths:

```bash
install -Dm644 packages/daemon/contrib/ghostd.service ~/.config/systemd/user/ghostd.service
systemctl --user daemon-reload
systemctl --user enable --now ghostd
```

`contrib/ghost.desktop` is a stub for the future Omarchy webapp wrapper; its
`Exec=` points at `http://127.0.0.1:7717` as a placeholder until the UI
package lands.

## Configuration

`~/.config/ghost/config.json` (XDG; `XDG_CONFIG_HOME` is honoured):

```json
{
  "port": 7717,
  "host": "127.0.0.1",
  "ghostsRoot": "~/Ghosts",
  "offline": false
}
```

Precedence: defaults < config file < environment < CLI flags. Environment
overrides are `GHOSTD_PORT`, `GHOSTD_HOST`, `GHOSTS_ROOT`, `GHOSTD_OFFLINE`,
`GHOSTD_CONFIG`, `XDG_CONFIG_HOME`. A missing config file is fine; a
malformed one is an error rather than a silent fallback, because defaulting
would quietly move someone's ghosts.

`host` must stay loopback. The v1 API has no auth (CONTRACTS.md: localhost
trust), so binding wider would publish every ghost's memory.

`offline: true` sets `PI_OFFLINE`, which stops pi's update checks, telemetry,
and **provider catalog refresh**. It is off by default: with it on, a ghost
can only use models declared statically in its own `models.json`, which would
break the zero-cost onboarding path below for anyone who had not written
their catalog out by hand. Credential isolation does not depend on it.

## Models — provider-agnostic by construction

Nothing in the daemon names a provider. A ghost's model configuration is
pi's own `models.json`, in the ghost's own directory:

```
~/Ghosts/<name>/.pi/models.json    providers + our `roles` binding
~/Ghosts/<name>/.pi/auth.json      pi's credential store (API keys and OAuth)
```

`models.json` is pi's native schema plus one key of ours, `roles`, which
binds an inference role to a `(provider, modelId)` pair. pi's schema has no
`additionalProperties` constraint, so it rides along untouched (there is a
test that asserts this). When `roles.chat_model` is absent the daemon falls
back to the first declared model of the first declared provider; when there
is no `models.json` at all, pi's own default selection applies.

### Try a ghost for free (OpenRouter)

OpenRouter always carries capable free models, and an OpenRouter account is
the intended zero-cost way in. Either paste a key:

```jsonc
{
  "providers": {
    "openrouter": {
      "name": "OpenRouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "api": "openai-completions",
      "apiKey": "sk-or-…",
      "models": [{ "id": "deepseek/deepseek-r1:free", "input": ["text"],
                   "contextWindow": 128000, "maxTokens": 8192 }]
    }
  },
  "roles": { "chat_model": { "provider": "openrouter",
                             "modelId": "deepseek/deepseek-r1:free" } }
}
```

…or generate the same file from the preset: `openRouterPreset({ apiKey })`.

`OPENROUTER_DEFAULT_FREE_MODEL` in `src/models.ts` is a **changeable
default**, not a hardcode — OpenRouter's free roster rotates, nothing in the
daemon branches on the value, and it is only used to seed a file you can
edit. Current free ids:

```bash
curl -s https://openrouter.ai/api/v1/models \
  | jq -r '.data[] | select(.pricing.prompt=="0") | .id'
```

(or <https://openrouter.ai/models?max_price=0>).

### Signing in with a subscription (ChatGPT, Claude, …)

**Verified in pi-ai 0.84.2:** subscription OAuth is first-class. The package
ships `auth/oauth/openai-codex.js` with `name: "OpenAI (ChatGPT Plus/Pro)"`
and `isSubscription: true` (provider id `openai-codex`, api
`openai-codex-responses`), alongside OAuth for `anthropic` (Claude Pro/Max),
`openrouter` ("Sign in with OpenRouter"), `github-copilot`, `xai`,
`kimi-coding`, and `radius`. Credentials land in `auth.json` as
`{ "type": "oauth", access, refresh, expires }`, and `ModelRuntime` refreshes
them under a store lock.

The daemon **does not implement an OAuth flow of its own** — it reuses pi's
by pointing `ModelRuntime` at the ghost's `auth.json`. To sign in today, run
pi's own login against the ghost's agent directory:

```bash
PI_CODING_AGENT_DIR=~/Ghosts/<name>/.pi pnpm exec pi
# then: /login  → pick the provider → "Sign in with ChatGPT"
```

`PI_CODING_AGENT_DIR` relocates pi's whole global state, `auth.json`
included, so the credential is written exactly where the daemon reads it.
Then bind the role:

```jsonc
{ "providers": {},
  "roles": { "chat_model": { "provider": "openai-codex", "modelId": "gpt-5-codex" } } }
```

(`builtinProviderPreset("openai-codex", "gpt-5-codex")` writes that.) No
`providers` entry is needed: pi supplies the endpoint and the catalog.

**Gap — wrap, not upstream:** a first-run user should not need a terminal.
Driving `ModelRuntime.login(providerId, "oauth", interaction)` from the
daemon needs an interaction channel (the flow emits `auth_url` / `device_code`
events and awaits prompts), which means HTTP routes CONTRACTS.md does not
have. That is a deliberate follow-up for the UI milestone, not an upstream
change: pi's API is sufficient as it stands.

### Anything else

`openAiCompatiblePreset({ providerId, baseUrl, modelId, api? })` covers
Ollama, vLLM, llama.cpp, LM Studio, a self-hosted gateway, or a relay —
`api: "pi-messages"` is a first-class value in pi-ai 0.84.2, so a relay
backend is declared exactly like any other provider.

## Credential isolation (the scrub list)

pi resolves provider credentials from the ambient environment as a fallback.
The spike proved the consequence: with `GEMINI_API_KEY` merely *present* in
the shell, a sovereign ghost silently gained 22 Google cloud models. So
`ghostd` deletes every provider credential from its own environment before pi
is touched (`src/env-scrub.ts`), and again in the `SessionHost` constructor,
which is idempotent. A ghost's credentials come only from its own
`models.json` and `auth.json`.

Removed by exact name:

| group | variables |
|---|---|
| provider API keys | `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`, `ANT_LING_API_KEY`, `AZURE_OPENAI_API_KEY`, `BASETEN_API_KEY`, `CEREBRAS_API_KEY`, `CLOUDFLARE_API_KEY`, `COPILOT_GITHUB_TOKEN`, `DEEPSEEK_API_KEY`, `FIREWORKS_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_CLOUD_API_KEY`, `GROQ_API_KEY`, `KIMI_API_KEY`, `MINIMAX_API_KEY`, `MINIMAX_CN_API_KEY`, `MISTRAL_API_KEY`, `MOONSHOT_API_KEY`, `NVIDIA_API_KEY`, `OPENAI_API_KEY`, `OPENCODE_API_KEY`, `OPENROUTER_API_KEY`, `QWEN_TOKEN_PLAN_API_KEY`, `QWEN_TOKEN_PLAN_CN_API_KEY`, `RADIUS_API_KEY`, `TOGETHER_API_KEY`, `XAI_API_KEY`, `XIAOMI_API_KEY`, `XIAOMI_TOKEN_PLAN_{AMS,CN,SGP}_API_KEY`, `ZAI_API_KEY`, `ZAI_CODING_CN_API_KEY` |
| ambient cloud credentials | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN`, `AWS_BEARER_TOKEN_BEDROCK`, `AWS_PROFILE`, `AWS_CONTAINER_CREDENTIALS_{FULL,RELATIVE}_URI`, `AWS_WEB_IDENTITY_TOKEN_FILE`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION`, `AZURE_OPENAI_BASE_URL`, `AZURE_OPENAI_RESOURCE_NAME`, `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` |

…and by name shape, so a provider a future pi adds is covered too:
`*_API_KEY`, `*_AUTH_TOKEN`, `*_OAUTH_TOKEN`, `*_ACCESS_TOKEN`,
`*_SECRET_ACCESS_KEY`. Nothing in `ghostd` reads a key from the environment,
so the broad sweep costs nothing. Only names are ever logged, never values.

## Session isolation

Per ghost, everything the daemon adds lives in dot-directories inside the
ghost home — the same precedent as `memory/.visitors/`:

```
~/Ghosts/<name>/.pi/         settings.json, models.json, auth.json
~/Ghosts/<name>/.sessions/   <conversation>.jsonl transcripts
```

`createAgentSession({ agentDir })` does **not** redirect session storage; only
`SessionManager.create/open(cwd, sessionDir)` does. The daemon uses
`SessionManager.open(<sessionDir>/<conversationId>.jsonl, sessionDir, home)`,
which creates the file when it does not exist, so a conversation id maps to a
stable transcript across daemon restarts.

Three more deliberate settings, all verified by tests:

- **A ghost is not a coding agent.** `noContextFiles`, `noSkills`,
  `noPromptTemplates`, and `appendSystemPromptOverride: () => []` together
  keep `AGENTS.md` / `APPEND_SYSTEM.md` above the ghost home out of the
  persona. The extension's `before_agent_start` then *replaces* the system
  prompt wholesale.
- **Project trust is denied.** `noExtensions: true`, so a `.ts` file dropped
  into `~/Ghosts/<name>/.pi/extensions/` is not loaded. A ghost home is user
  data that may arrive in an imported archive; loading code from it would be
  arbitrary code execution.
- **No built-in tools.** `noTools: "all"` plus the tool allowlist from
  `@ghost/extensions` (`ghostToolNamesFor(scope)`) plus an `excludeTools`
  denylist of every pi built-in. A ghost has no bash and no filesystem.

Compaction is disabled: a ghost's durable memory is its memory files, not its
transcript.

## HTTP API

Exactly CONTRACTS.md, on `127.0.0.1`, no auth.

| method | path | body → response |
|---|---|---|
| GET | `/api/ghosts` | → `[{ name, dir, createdAt }]` |
| POST | `/api/ghosts` | `{ name }` → `201 { name, dir, createdAt }` |
| POST | `/api/ghosts/:name/messages` | pi-messages request → SSE of pi-messages events |
| GET | `/api/ghosts/:name/sessions` | → `[{ id, path, name?, created, modified, messageCount }]` |

Errors are `{ "error": { "message", "code" } }` — the shape the pinned
pi-messages client parses out of a non-2xx response, and the same shape the
hosted relay returns. Codes: `invalid_request`, `invalid_name`, `not_found`,
`already_exists`, `session_busy`, `payload_too_large`, `method_not_allowed`,
`shutting_down`, `internal_error`.

### The pi-messages wire

Request: `{ model, context: { systemPrompt?, messages, tools? }, options }`.
A client-supplied `systemPrompt` or `tools` list is **untrusted and ignored**
— the ghost assembles its own from its home.

Response: `text/event-stream`. Frames are `data: <json>\n\n`; the client
takes the first `data:` line of each blank-line-separated frame, so
`: keepalive` comments (sent every 15s) and a trailing `data: [DONE]` are
invisible to it. `x-ghost-turn-id` is echoed from the request when it matches
`[A-Za-z0-9_.:-]{1,64}`, minted otherwise.

## AgentSessionEvent → pi-messages

The seam is `message_update.assistantMessageEvent`: pi's agent loop forwards
the provider's `AssistantMessageEvent` stream there verbatim, which is the
same event type the hosted runtime tapped. Step boundaries are invisible on
the wire, but **each provider step restarts `contentIndex` at 0**, and the
client indexes one flat content array — so indices are renumbered through a
single monotonic counter for the whole turn. Suppressed blocks consume no
wire index.

| pi `AgentSessionEvent` | inner `assistantMessageEvent` | emitted pi-messages event | notes |
|---|---|---|---|
| `agent_start` | — | `start` | emitted once per turn, ever |
| `message_start` (assistant) | — | — | new provider step: reset the step→wire index map |
| `message_update` | `text_start` | `text_start` | assigns the next wire `contentIndex` |
| `message_update` | `text_delta` | `text_delta` | |
| `message_update` | `text_end` | `text_end` | `content` carried through |
| `message_update` | `thinking_start/_delta/_end` | *(dropped)* | reasoning quotes private memory; `includeThinking` forwards it |
| `message_update` | `toolcall_start` | `toolcall_start` | `id`/`toolName` read from `partial.content[i]` — pi's event carries neither |
| `message_update` | `toolcall_delta` | `toolcall_delta` | raw argument JSON |
| `message_update` | `toolcall_end` | `toolcall_end` | `toolCall` = the finalized content block |
| `message_end` (assistant) | — | — | adds the step's `usage` to the turn total |
| `message_end` with `stopReason: error\|aborted` | — | `error` | terminal; carries `errorMessage` |
| `agent_end` with `willRetry: false` | — | `done` | terminal; aggregate usage; `reason` from the last `stopReason` |
| `agent_end` with `willRetry: true` | — | — | pi is retrying; the turn is not over |
| *(transport/refusal, outside pi)* | — | `error` | `finishError()`; `reason: "aborted"` when the visitor disconnected |
| `turn_start`, `turn_end`, `tool_execution_*`, `queue_update`, `compaction_*`, `auto_retry_*`, `entry_appended`, … | — | *(dropped)* | not part of the wire union |

Everything else about the turn — tool *results*, session bookkeeping — never
reaches the wire, because the pi-messages union has no event for it. Tool
**calls** are visible (start/delta/end); tool **results** are not, which
matches the hosted client's expectations exactly.

## Deltas from the hosted implementation

Documented rather than silently different:

1. **History is the daemon's, not the request's.** The hosted relay converted
   `context.messages` into the model context. Here the pi session owns the
   conversation, so only the newest user message is taken from the request
   and `options.sessionId` selects the transcript. A client that replays old
   turns will not duplicate them.
2. **No turn-join on re-POST.** The relay let a re-POST with the same
   `x-ghost-turn-id` join an in-flight generation after a dropped socket.
   The daemon instead refuses a second concurrent turn in the same
   conversation with `409 session_busy`; the turn id is still echoed. There
   is no eviction to recover from on localhost.
3. **No `rewrite` field.** That was a gateway-policy artifact; nothing here
   rewrites messages.
4. **A visitor disconnect aborts the turn.** The SSE `close` event aborts the
   agent run rather than letting it finish into a dead socket.
5. **CORS for loopback origins only.** Not in CONTRACTS.md; added so a UI on
   a dev server (`http://localhost:5173`) can reach the daemon. A remote
   origin gets no CORS headers at all.
6. **Thinking is dropped by default**, matching the hosted visitor policy.
   `includeThinking` on the server turns it back on for a creator UI.

## Tests

```bash
pnpm --filter @ghost/daemon test
```

No test ever calls a real model: `test/helpers/mock-provider.ts` is a
scripted OpenAI-compatible SSE server (ported from the spike) that emits real
tool calls, binds an ephemeral loopback port, and records what the agent
actually sent so assertions run against ground truth. The HTTP tests run over
a real listening server and parse the SSE body with the pinned client's own
algorithm.
