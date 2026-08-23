# Contracts

The interfaces the packages build against. Change these deliberately, in one
commit, with every consumer updated.

## Ghost home (`ghost-home/v1`)

One directory per ghost. Plain files; anything derivable (memory index, note
catalog) is derived per session and never stored.

```
~/Ghosts/<name>/
  character.md                 persona → system prompt (frontmatter: public: true, title)
  notes/**/*.md                YAML frontmatter: public: false by default; optional
                               title, tags, archived, path (pre-sanitization app path)
  memory/*.md                  atomic memory files: frontmatter description + updated,
                               body = the fact
  memory/.visitors/<id>/*.md   per-visitor memory, same format; dot-folder keeps it
                               out of the creator's default view but inspectable
  conversations/*.json         transcripts (import fixture from the hosted export;
                               the daemon's own sessions live in pi session storage)
  export-manifest.json         present in imported archives; counts, pathRewrites,
                               notIncluded
```

Terminology: **visitors**, never "callers".

## Daemon HTTP API (localhost only)

### Authentication

Bind to `127.0.0.1`, **and** authenticate. A loopback bind is not
authentication: every browser on the machine reaches loopback too, and a page
the creator visits can send a `text/plain` POST to
`http://127.0.0.1:7717/api/ghosts/<name>/messages` with no preflight at all —
CORS decides whether a page may *read* a response, not whether it may *send* a
request, and a CSRF attacker does not want the response. Without the checks
below, any web page could silently drive a ghost turn, including its browser
and desktop tools (issue #485).

Three checks, applied to every `/api` request before routing:

1. **Bearer token.** `Authorization: Bearer <token>`, compared in constant
   time, where `<token>` is 64 hex characters read from
   `$XDG_STATE_HOME/ghost/api-token` (default
   `~/.local/state/ghost/api-token`; override with `GHOSTD_API_TOKEN_FILE`),
   mode `0600` in a `0700` directory. The daemon mints it when the server
   starts — not lazily on first use, so a client starting alongside it finds
   the file. Missing or wrong → `401 unauthorized` with
   `www-authenticate: Bearer`. A local client authenticates by *reading the
   file*; a web page cannot read files, which is the whole mechanism.
2. **Origin.** A request that carries an `Origin` header must carry a loopback
   one (`http://127.0.0.1|localhost|[::1]`, optional port), else
   `403 forbidden_origin`. Browsers always send `Origin` on a cross-site
   request; file-reading clients send none, so absent is allowed.
3. **Content type.** `POST` and `PUT` must be `application/json` (parameters
   such as `; charset=utf-8` are fine), else `415 unsupported_media_type`.
   That excludes exactly the three types a cross-site form post can produce
   without a preflight.

Two deliberate exemptions, which must not be widened:

- `OPTIONS` answers `204` unauthenticated. A preflight cannot carry
  credentials — carrying them is what it is asking permission to do.
- `GET /api/relay/status` is exempt from both the token and the origin check.
  It returns no secret (never the relay token, only the path it lives at), and
  it is the one thing a client with no token yet may legitimately need to read.

`ghostd api-token [--rotate] [--quiet]` prints the token — for curl, scripts,
and diagnosing a 401. Clients read the file themselves. `--rotate` mints a new
one; a running daemon keeps the token it started with, and a running client
should re-read the file on its first `401` and retry once. The browser relay's
pairing token is a **separate** secret in the same directory (`relay-token`,
`ghostd relay-token`) because it is pasted into a browser extension; a leak of
one must not be a leak of both.

### Routes

- `GET  /api/ghosts` → `[{ name, dir, createdAt }]`
- `POST /api/ghosts` `{ name }` → creates `~/Ghosts/<name>/` with a seeded
  `character.md`
- `POST /api/ghosts/:name/messages` — the **pi-messages wire protocol** over
  OMP's `AgentSession` (request `{ model, context, options }` → SSE stream).
  The pinned client in the summon-ghost repo is the normative spec
  (`~/github.com/ferdousbhai/summon-ghost`, read-only reference).
- `GET  /api/ghosts/:name/sessions` → `{ sessions: [{ id, title, createdAt,
  updatedAt, messageCount }] }` — the ghost's conversations, **newest-updated
  first**. `id` is the conversation id used to resume it (the pi-messages
  `options.sessionId`); `title` is a short auto-generated name or `null` until
  one is generated (see "Conversation titles" below). OMP transcripts and Claude
  Code resume sidecars share this shape (a Claude conversation's `title` is
  `"Claude Code"`).
- `DELETE /api/ghosts/:name/sessions/:id` → `{ ok: true }` — permanently deletes
  the conversation's OMP transcript and/or Claude Code resume sidecar. An active
  conversation must finish or be cancelled first (`409 session_busy`); an
  unknown conversation returns `404 not_found`.
- `GET  /api/ghosts/:name/sessions/:id/transcript` → `{ id, title, messages,
  total, truncated }` — a past conversation's history so the shell can rehydrate
  it (issue #26). `messages` are OMP's `{ role, content }` messages (user and
  assistant only; private `thinking` reasoning and internal tool-result messages
  are dropped, exactly as the live stream omits them), the same shape a
  pi-messages client renders. Paged with `?limit` (default 1000, max 2000) and
  `?offset`; `total` is the full renderable count and `truncated` is true when a
  page omits messages. Each message also carries its persisted `entryId` and
  `parentId`; branch points carry `{ index, count, previousEntryId?,
  nextEntryId? }`. Ask tool calls carry equivalent `ghostAsk` navigation
  metadata. `404 not_found` for an unknown conversation id. Only OMP
  conversations are readable here; a Claude Code conversation's transcript lives
  in that runtime's own storage.
- `GET /api/ghosts/:name/sessions/:id/ask` → `{ ask }`, where `ask` is the
  currently pending OMP interaction or `null`.
- `POST /api/ghosts/:name/sessions/:id/ask` resolves it. The body is
  `{ askId, kind: "submit", results }`, `{ askId, kind: "chat" }`, or
  `{ askId, kind: "cancel" }`. The first valid response wins; stale ids return
  a conflict. `ask` is human input, not tool approval.
- `GET|POST /api/ghosts/:name/sessions/:id/queue` reads or enqueues OMP's
  native mid-turn queues. POST is `{ mode: "steer"|"followUp", text }`:
  steering enters the active run, while follow-up runs after it.
- `POST /api/ghosts/:name/sessions/:id/branch` with `{ action:
  "rewind"|"navigate", entryId }` either returns an earlier user message as an
  editable draft or selects an existing sibling branch.
- `POST /api/ghosts/:name/sessions/:id/reanswer` with `{ entryId }` reopens a
  persisted `ask` result, commits the answer as a sibling, and resumes the model
  on that branch. Its response is an SSE stream and includes `branch_changed`.

### Conversation titles (the `title_model` role)

After the first turn of a conversation completes, the daemon generates a 3-6
word title from the first user message with one cheap completion, fire-and-forget
(mirroring background compaction): it never blocks the reply and a failure is
logged, never fatal. A conversation is titled once and never re-titled.

The title is stored as an OMP **`session_info` entry** inside the conversation's
own `.sessions/*.jsonl` transcript (OMP's native display-name mechanism, which
never enters the model's context), so it needs no sidecar and rides the same
per-ghost storage backup and future encryption cover. `GET …/sessions` surfaces
it as `title`.

Which model writes the title is the `title_model` role in `.pi/models.json`,
resolved daemon-side:

1. `roles.title_model` — the creator's explicit choice; a missing or
   uncredentialed model there is a loud (logged) error, not a silent fallback.
2. otherwise the **cheapest USABLE model, subscription-aware** (issue #484): a
   capable model on an already-authenticated subscription — `isSubscription`, or
   `connectedVia` `oauth`/`claude_plan` — has zero marginal cost and is preferred
   over a cheaper metered model; only then cheapest by `cost.input`. "Cheapest
   effective cost, subscription = free."
3. otherwise a loud error — only when there is genuinely no usable model.

### Model indicator + switcher (which model a ghost uses, and switching it)

Provider models come from modern OMP's `ModelRegistry`, backed by its models.dev
catalogue. One runtime entry is code-owned:
`claude-code/default`, representing the installed Claude Code harness rather
than an API model. Its usability comes from the boolean result of external
`claude auth status --json`; no credential is read into or emitted from a
response.

- `GET  /api/ghosts/:name/model` → the current selection:
  `{ current: { provider, id, name?, contextWindow?, hasVision } | null,
  source: "role" | "default" | "none" }`. `role` — `roles.chat_model` is set
  and resolves; `default` — Ghost/OMP's fallback (a hand-declared provider's first
  model, then the first available model); `none` — nothing usable, `current` is
  null. Resolved with the same logic session-host uses.
- `GET  /api/ghosts/:name/models?scope=available|catalog&provider=<id>&q=<search>&limit=<n>&offset=<n>`
  → `{ scope, models: [...], total, limit, offset, provider?, q? }`.
  - `scope=available` (default): models the ghost can use right now (from
    credentialed providers, via `getAvailable()`). Each row is
    `{ provider, id, name?, contextWindow?, cost?, hasVision, connectedVia?,
    current }`, tagged by `provider`, with `current: true` on the selected one.
    `connectedVia` is `oauth | api_key | claude_plan`.
  - `scope=catalog`: the full OMP catalogue (`getModels()`, every provider,
    logged in or not), same row shape plus `usable: boolean` (is the provider
    credentialed; `connectedVia` present only when usable). Supports the
    `provider` filter and a case-insensitive `q` substring match on id/name.
  - Both scopes are paginated. Providers keep catalogue order; within each
    provider, OMP's priority is respected and model families are ordered by
    descending semantic version/date, so current models appear before older
    ones. `limit` defaults to 100 and is capped at 500.
- `PUT  /api/ghosts/:name/model` `{ provider, id }` → set `roles.chat_model`.
  Validates the model exists in the OMP catalogue (`getModel`) or equals the
  code-owned `claude-code/default` runtime entry; an unknown model is a
  structured `400 unknown_model`. If the provider/runtime is not usable the
  write still happens and the response is `{ ok: true, usable: false, warning,
  current, source: "role" }` so the shell can prompt a login rather than the
  switch failing silently; a credentialed provider returns
  `{ ok: true, usable: true, current, source: "role" }`.

Requires `PUT` in the loopback CORS allow-list.

### Model roles and fallback chains

`GET /api/ghosts/:name/model-routing` returns `{ roles }` for `chat_model`,
`vision_model`, `title_model`, `general_purpose_model`, and `research_model`.
Each row contains the OMP role name, its primary model, and its ordered
fallbacks with resolved/usable status.

`PUT /api/ghosts/:name/model-routing` accepts `{ role, target, provider, id }`,
where `target` is `primary` or `fallback`; `{ role, target:
"clear_fallbacks" }` clears a chain. Vision primaries/fallbacks must accept
images. `claude-code/default` is valid only as the primary chat runtime because
it is not an OMP provider model.

Ghost persists this in `.pi/models.json` under `roles` and `fallbacks`, then
projects it onto OMP's `modelRoles` and `retry.fallbackChains`. OMP owns retry
classification, provider cooldowns, and fallback execution. A successful model
selection returns immediately and the shell closes the picker back to chat.

### Model login (`ghostd` drives OMP's provider OAuth / API-key flows)

Signing a ghost into a provider is interactive and multi-step, so it is modeled
as a short-lived, pollable login session. Credentials are written by OMP's
`AuthStorage` to the ghost's `<home>/.pi/agent.db` and nowhere else; a pasted code
or key is never echoed in a GET body or a log.

- `GET  /api/ghosts/:name/providers` → `{ providers: [{ id, name, subscription,
  authTypes: ("oauth"|"api_key")[], loginLabel?, billingNote?, configured,
  connectedVia? }] }`,
  derived from OMP's registry (openai-codex, openrouter, anthropic, github-copilot,
  xai, …). Ambient-only providers and the externally authenticated
  `claude-code` runtime are omitted.
- `POST /api/ghosts/:name/login` `{ providerId, authType }` → `201` with the
  initial **login view** (below), including `loginId`.
- `GET  /api/ghosts/:name/login/:loginId` → the current **login view**: the step
  to show. Poll it.
- `POST /api/ghosts/:name/login/:loginId/input` `{ value }` → satisfy an awaiting
  prompt (a pasted code, an api key, or a selected option id) → the updated view.

The **login view** is
`{ loginId, providerId, authType, status, message?, authUrl?, authInstructions?,
deviceCode?, verificationUrl?, deviceExpiresInSeconds?, prompt?, modelBound?,
error? }` where `status` is one of `starting | working | awaiting_url |
awaiting_device_code | awaiting_input | awaiting_select | succeeded | failed`,
and `prompt` (when present) is `{ kind: "text"|"secret"|"manual_code"|"select",
message, placeholder?, secret, options? }`. A callback-server flow carries an
`authUrl` AND a paste `prompt` at once (open the URL, or paste the code). On
`succeeded`, `modelBound` is set when the ghost had no chat model and one was
bound. Abandoned logins time out and are cleaned up server-side.

The same flow runs in the terminal as `ghostd login [<ghost>] [--provider <id>]
[--api-key]`.

For an existing installation, `.pi/auth.json` is imported into `agent.db` once,
without deleting the legacy file. After migration, `agent.db` is canonical.

### Claude Code plan runtime (external auth)

`roles.chat_model = { provider: "claude-code", modelId: "default" }` selects
the official Claude Agent SDK + an installed, unmodified `claude` executable.
The creator runs `claude auth login` outside Ghost. Ghost accepts no Claude
credential, stores no Claude credential, and removes ambient API/OAuth-token
variables from the subprocess environment.

The runtime is creator-only. A visitor scope fails with
`403 claude_code_owner_only`; the creator's subscription must never fund or be
resold to visitor traffic. Claude built-in coding/filesystem tools, filesystem
settings, project instructions, skills, plugins, and non-Ghost MCP servers are
disabled. Existing Ghost extension tools are exposed through one in-process
SDK MCP server, and the output is normalized back to pi-messages.

Each turn is an Effect scope. It rebuilds the Ghost system prompt, resumes the
opaque Claude session id, streams one turn, atomically writes a mode-`0600`
metadata sidecar under `.sessions/`, emits one terminal event, and closes the
query. Claude Code owns the actual transcript under its own
`~/.claude/projects/` storage; the sidecar is not a transcript. Full rationale,
T3 Code provenance, policy caveat, and legal boundary:
[`docs/claude-code-runtime.md`](docs/claude-code-runtime.md).

Bind to `127.0.0.1`, and require the bearer token described under
[Authentication](#authentication) above. Loopback bind ≠ auth. Revisit the
whole model before any non-local exposure.

## Package boundaries

- `packages/extensions` — pure OMP extensions + ghost-home fs helpers. No HTTP,
  no daemon lifecycle. Exports the extension factories and the ghost-home
  reader/writer.
- `packages/daemon` — per-ghost OMP `AgentSession` and Claude Code query
  lifecycles, env scrubbing, model/runtime selection, the HTTP API, systemd
  unit. Depends on `extensions`.
- `packages/shell` — the Omarchy/Quickshell HUD, model routing, ask/queue and
  branching UI, live tool cards, and summoning indicator.

## OMP 18 harness invariants

- `createAgentSession({ agentDir })` does NOT redirect session storage — use
  `SessionManager.create(cwd, sessionDir)` or sessions land in global `~/.pi`.
- Scrub inherited env before session creation: stray provider API keys
  (e.g. `GEMINI_API_KEY`) silently add cloud models to a sovereign ghost.
- Parallel tool calls: wrap shared-file mutations in a file mutation queue.
- Tools should throw structured errors, not return `isError` payloads.
- Disable discovered resources, context files, skills, MCP/LSP/IRC, and coding
  tools explicitly. Ghost enables only its scoped extensions and OMP's `ask`.
- Tool approvals remain disabled (`yolo`/auto-approve); `ask` is never an
  approval prompt.
