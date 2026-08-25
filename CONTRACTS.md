# Contracts

The interfaces the packages build against. Change these deliberately, in one
commit, with every consumer updated.

## Ghost home (`ghost-home/v1`)

One directory per ghost. Plain files; anything derivable (memory index, doc
catalog) is derived per session and never stored.

```
~/Ghosts/<name>/
  character.md                 persona → system prompt (optional title frontmatter)
  docs/**/*.md                 optional YAML frontmatter: title, tags, archived,
                               path (pre-sanitization app path)
  memory/*.md                  atomic memory files: frontmatter description + updated,
                               body = the fact
  .omp/                        OMP-native project skills, rules, tools, commands,
                               extensions, plugins, prompts, and MCP configuration
  .pi/                         per-ghost OMP settings, model roles, and credentials
  .sessions/                   daemon-owned OMP transcripts and runtime sidecars
  .sessions/pins.json          pinned-conversation ids: { "pinned": ["<id>", …] }
  conversations/*.json         lossless source transcripts from the hosted export;
                               retained unchanged after native activation
  export-manifest.json         present in imported archives; counts, pathRewrites,
                               notIncluded
```

`docs/` is canonical. A legacy home or hosted `ghost-home/v1` archive may carry
`notes/`; daemon startup and import migrate that directory to `docs/` without
rewriting file bytes. The live-home migration is atomic when only `notes/`
exists; if both directories exist, startup fails with a conflict instead of
guessing which files win. Import rejects archive entries that collide after
translation. New homes and all new writes use only `docs/`.

Hosted conversation JSON is also a migration fixture, not the daemon's live
session store. `ghostd import` and daemon startup idempotently project each valid
`conversations/*.json` file into a native OMP transcript in `.sessions/`, keeping
the conversation and message ids, roles, title, available message timestamps,
conversation created/updated times, readable text and attachments, and paired
tool calls/results. A missing message timestamp is placed deterministically
between the conversation timestamps; the export did not contain a value to
preserve. The source JSON is never rewritten or deleted. An existing native
target always wins and is never overwritten; malformed fixtures remain in place
and are reported without preventing the ghost from starting.

`.pi/` holds live provider credentials, and OMP stores them unencrypted: the
`auth_credentials` row in `agent.db` is plain JSON behind nothing but 0600. That
is an acceptable posture for a file that never leaves the machine, and the whole
of it rests on that clause. **Nothing that copies a ghost home off this machine
may include `.pi/`.** There is no export path today, only import, so this is a
constraint on the one that gets built rather than a description of one that
exists. Ghost cannot fix the storage itself until it owns the credential loader
(#14, #3).

A deleted ghost home leaves the root entirely, for the system trash; see the
`DELETE` route.

### Session capabilities

Ghost is a single-caller product: the owner is the only user, and every
session uses the same home, memory, docs, tools, and route behavior.

A session is OMP-native. Ghost preserves OMP's system prompt and
discovery, then appends the Ghost persona and derived memory/doc sections.
Native filesystem and search (`read`, `glob`, `grep`), mutation (`write`,
`edit`), Bash, web search, task/hub subagents, background jobs, skills, rules,
project context, extensions/plugins, commands, and the ghost home's own project
MCP remain available under OMP's normal xd:// presentation. MCP is a deliberate
sovereignty exception to OMP's normal multi-source discovery: an OMP
session loads only `<ghost>/.omp/mcp.json` (or the legacy `.omp/.mcp.json`) and
never discovers or loads user/global OMP config or another coding agent's MCP
config (`~/.codex`, `~/.claude`, `~/.copilot`, and similar). Ghost otherwise
disables only the overlapping OMP browser and computer tools because
`ghost_browser`, `ghost_desktop`, and `ghost_screen` own those surfaces, and
OMP's memory/autolearn backends because ghost memory is plain files in the ghost
home (see the harness invariants). Image inspection is OMP-native:
`inspect_image` in its default auto mode, resolving the `vision` role that the
daemon projects from models.json's `vision_model`.

Docs and memory retrieval use those native filesystem tools directly.
Ghost registers no duplicate doc list/read/search/write tools, and
keeps only `ghost_memory_write` for validated, atomic memory-file writes. The
memory index and doc catalog are derived from disk before each model turn and
are never stored. `/skill:<name> [args]` is explicit force-invocation of a
discovered skill; native `read` remains the model-driven discovery path.

`!command` executes immediately through OMP's session-aware Bash runner without
a model turn. `!!command` does the same but excludes the result from future
model context. Both appear in the live event stream and are
persisted in an OMP transcript; a successful standalone `cd` changes the
conversation working directory without relocating that transcript.

## Daemon HTTP API (localhost only)

### Authentication

Bind to `127.0.0.1`, **and** authenticate. A loopback bind is not
authentication: every browser on the machine reaches loopback too, and a page
the owner visits can send a `text/plain` POST to
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
- `DELETE /api/ghosts/:name?confirm=<name>` → `{ ok: true, trash: "<abs path>" }`
  — moves `<root>/<name>/` to the freedesktop home trash
  (`$XDG_DATA_HOME/Trash`, default `~/.local/share/Trash`): the home becomes
  `Trash/files/<name>` with a matching `Trash/info/<name>.trashinfo`
  (`Path=` the original absolute path, percent-encoded; local `DeletionDate=`),
  `<name>.2`, `<name>.3`, … on collision. A deleted ghost is therefore an
  ordinary trashed directory, restorable with `gio trash --restore` or any file
  manager. The move is a same-filesystem rename; `EXDEV` falls back to
  `<root>/.trash/<name>-<YYYYMMDD-HHMMSS>[-<n>]/`, still a move, recovered with
  a plain `mv`. Nothing removes a trashed ghost — not the daemon, not on a
  schedule; emptying the trash is the owner's. Checked in this order:
  `confirm` must be present and byte-equal to `:name`
  (`400 confirmation_required`); an unknown ghost is `404 not_found`; a ghost
  with any conversation busy, opening, or mid-delete — pi or Claude Code — is
  `409 ghost_busy`, as is a second concurrent delete of the same ghost. Idle
  hosted sessions are closed (disposed, not deleted) and pending
  title/compaction work is awaited first. **Deletion is a move, never an `rm`**:
  the ghost home holds the only copy of a persona, its memory, and its docs, so
  nothing on any path follows the rename with a recursive removal.
- `POST /api/ghosts/:name/messages` — the **pi-messages wire protocol** over
  OMP's `AgentSession` (request `{ model, context, options }` → SSE stream).
  The pinned client in the summon-ghost repo is the normative spec
  (`~/github.com/ferdousbhai/summon-ghost`, read-only reference).
- `GET  /api/ghosts/:name/sessions` → `{ sessions: [{ id, title, createdAt,
  updatedAt, messageCount, pinned }] }` — the ghost's conversations, **pinned
  first, then newest-updated first within each group**. `id` is the
  conversation id used to resume it (the pi-messages `options.sessionId`);
  `title` is a short auto-generated name or `null` until one is generated (see
  "Conversation titles" below). OMP transcripts and Claude Code resume sidecars
  share this shape (a Claude conversation's `title` is `"Claude Code"`).
- `PUT  /api/ghosts/:name/sessions/:id/pin` `{ pinned: boolean }` →
  `{ ok: true, pinned }` — pin or unpin one conversation, idempotently. Pin
  state lives in `.sessions/pins.json` (atomic replace, never partial), works
  for OMP and Claude Code conversations alike, and is user state, not derivable
  — the one deliberate exception in the daemon-owned dir. A non-boolean
  `pinned` is `400 invalid_request`; an unknown conversation id is `404 not_found`.
  Deleting a conversation drops its pin; a stale id (conversation gone) is
  ignored on read and pruned on the next write.
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
  `parentId`. Sibling-branch metadata is gone with the navigation it described:
  branching forks the conversation instead of walking a tree in place. Ask tool
  calls carry `ghostAsk` with the `resultEntryId` a re-answer branches from,
  plus `settled: "submitted" | "cancelled" | "timedOut" | "chat"`,
  always present and derived from the persisted tool result, so a restored ask
  card states how that question actually closed rather than assuming an answer.
  `404 not_found` for an unknown conversation id. Only OMP
  conversations are readable here; a Claude Code conversation's transcript lives
  in that runtime's own storage.
- `GET /api/ghosts/:name/sessions/:id/ask` → `{ ask }`, where `ask` is the
  currently pending OMP interaction or `null`. A pending ask carries `timeoutAt`
  when one is armed.
- `POST /api/ghosts/:name/sessions/:id/ask` resolves it. The body is
  `{ askId, kind: "submit", results }`, `{ askId, kind: "chat" }`, or
  `{ askId, kind: "cancel" }`. The first valid response wins; stale ids return
  a conflict. `ask` is human input, not tool approval.
- **A pending ask can also resolve with no client involved.** The daemon arms a
  deadline (`askTimeoutSeconds`, default 120; `0` waits forever), and on expiry
  submits the question's recommended option and lets the turn continue, which is
  what keeps a conversation from stalling on a question nobody is there to
  answer. A question that names its own `timeout` keeps it. A client can
  therefore find an ask gone that it never answered: `GET` returns `null` and
  `POST` is `409 ask_not_pending`, which means settled rather than broken. The
  clock starts when the question is presented, not when the model asked it, so a
  slow turn does not spend the budget before anyone can see it.

  The deadline is daemon-wide rather than per-ghost: how long a dialog waits is
  a property of the person at the keyboard, not of the persona asking, and a
  ghost home holds only what makes that ghost that ghost.
- `GET|POST /api/ghosts/:name/sessions/:id/queue` reads or enqueues OMP's
  native mid-turn queues. POST is `{ mode: "steer"|"followUp", text }`:
  steering enters the active run, while follow-up runs after it.
- `POST /api/ghosts/:name/sessions/:id/branch` with `{ action: "fork",
  entryId }` → `{ sessionId, title, draft, transcript }` — branching off is a
  **copy, not a rewind**. The conversation's transcript is forked into a new one
  (pi's `SessionManager.forkFrom`, whose header records `parentSession`), the
  copy is rewound to just before `entryId`, and that user message's text comes
  back as `draft` for the composer. `sessionId` is the new conversation, already
  in `GET …/sessions`; `transcript` is its rewound history. The source
  conversation is left untouched, leaf included. `entryId` must be a persisted
  user message (`400 invalid_branch`), the source must be idle
  (`409 session_busy`), and any other `action` is `400 invalid_request`.
  In-file sibling branches are not part of the API: there is no `navigate`.
- `POST /api/ghosts/:name/sessions/:id/reanswer` with `{ entryId }` reopens a
  persisted `ask` result, commits the answer as a sibling, and resumes the model
  on that branch. Its response is an SSE stream and includes `branch_changed`.
- `POST /api/ghosts/:name/greeting` `{}` → `{ greeting: string | null,
  onboarding: boolean }` — one smol-lane completion (see below) writes a short
  in-persona opener for an empty chat from the character file, memory index,
  doc catalog, and the current time. `greeting` is `null` on ANY generation
  failure (no usable model, provider error, timeout, output rejected by
  validation) — never a 5xx; the shell keeps its static invitation and the
  greeting is pure upside. `onboarding` is true while `character.md` is
  missing, blank, or still byte-equal to the seed, and is recomputed per
  request even when generation fails. Cached per ghost (TTL ~10 min,
  single-flight), invalidated when `character.md` changes.

### The smol lane (the `smol_model` role)

One cheap, fast model role carries every side-completion that must never block
a reply or bill like a chat turn. The role name adopts OMP's own convention
(`modelRoles.smol`, the `@smol` alias family). Two consumers today:

**Conversation titles.** After the first turn of a conversation completes, the
daemon generates a 3-6 word title from the first user message with one smol
completion, fire-and-forget (mirroring background compaction): it never blocks
the reply and a failure is logged, never fatal. A conversation is titled once
and never re-titled. A fork is named at fork time instead, the way a file
manager names a copy: `<source title> (n)` for the smallest free `n` from 2 up,
with any trailing ` (k)` stripped from the base first, so a fork of a fork does
not stack suffixes. An untitled source forks to an untitled conversation. The title is stored through OMP's native fixed-width
**`title` slot** at the start of the conversation's own `.sessions/*.jsonl`
transcript, with its append-only `title_change` audit entry. It never enters the
model's context, needs no sidecar, and rides the same per-ghost storage backup
and future encryption cover. `GET …/sessions` surfaces it as `title`. A
pre-OMP-18 transcript instead carries pi 0.84's appended `session_info.name`;
the daemon reads that title immediately and promotes it to the native OMP slot
on the conversation's next writable open, without generating a replacement.

**Greetings.** `POST …/greeting` (above) writes the empty-chat opener with one
smol completion: 1-3 sentences in the ghost's own voice, at most one timely
detail (time of day, a gap since the last conversation, something from memory),
ending with an invitation to talk. Character, memory-index, and doc-catalog
inputs are fenced as untrusted data; output that answers instead of greeting is
rejected outright, never truncated.

Which model serves the lane is the `smol_model` role in `.pi/models.json`,
resolved daemon-side:

1. `roles.smol_model` — the owner's explicit choice; a missing or
   uncredentialed model there is a loud (logged) error, not a silent fallback.
2. otherwise the **cheapest USABLE model, subscription-aware** (issue #484): a
   capable model on an already-authenticated subscription — `isSubscription`, or
   `connectedVia` `oauth`/`claude_plan` — has zero marginal cost and is preferred
   over a cheaper metered model; only then cheapest by `cost.input`. "Cheapest
   effective cost, subscription = free."
3. otherwise a loud error — only when there is genuinely no usable model.

Legacy `roles.title_model` / `fallbacks.title_model` keys (the role's old name)
are read as `smol_model` when the new key is absent; writers persist only
`smol_model`.

### The first meeting (onboarding)

While `character.md` is missing, blank, or byte-equal to the seed, sessions —
OMP and Claude Code runtimes alike — get a
"first meeting" system-prompt section: interview the owner with genuine
curiosity (one question at a time, the owner's request always first), save
durable facts as declarative memories, offer docs for ongoing projects, and
eventually draft and write the character with the
`ghost_character` tool (read/write `character.md`). The populated character
file IS the completion latch — there is no separate onboarding state — and the
section stops being injected on the first session after the file deviates from
the seed.

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
`vision_model`, `smol_model`, `general_purpose_model`, and `research_model`.
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
The owner runs `claude auth login` outside Ghost. Ghost accepts no Claude
credential, stores no Claude credential, and removes ambient API/OAuth-token
variables from the subprocess environment.

The runtime uses the owner's local Claude Code authentication. The native
Claude Code system prompt, tools,
filesystem settings, project instructions, skills, plugins, subagents, web
search, and MCP configuration remain enabled with bypass-permissions mode,
matching the unrestricted owner-local OMP runtime. Existing Ghost extension
tools are added through one in-process SDK MCP server, and the output is
normalized back to pi-messages. Ambient provider credentials are still
scrubbed; removing tool restrictions does not turn Ghost into a credential
proxy.

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
- `packages/chromium-extension` — the "my browser" relay, driving one tab of the
  browser the user is already signed into. The default mode stays "Ghost's
  browser", a dedicated Playwright Chromium profile under the ghost home, and
  remains the right choice for anything autonomous.
- `packages/desktop-helper` — Python, not pnpm. A long-lived PyGObject sidecar
  for Hyprland/Wayland computer-use, driven by the `ghost_desktop` and
  `ghost_screen` extensions over line-oriented JSON on stdin/stdout. Managed with
  `uv`; the root `pnpm -r` scripts do not reach it.

## OMP 18 harness invariants

- `createAgentSession({ agentDir })` does NOT redirect session storage — use
  `SessionManager.create(cwd, sessionDir)` or sessions land in global `~/.pi`.
- Scrub inherited env before session creation: stray provider API keys
  (e.g. `GEMINI_API_KEY`) silently add cloud models to a sovereign ghost.
- Parallel tool calls: wrap shared-file mutations in a file mutation queue.
- Tools should throw structured errors, not return `isError` payloads.
- Sessions omit non-MCP discovery/tool restrictions and load read-only effective
  OMP settings for the ghost cwd/agent directory. Their MCP manager is
  injected from that ghost's `.omp/mcp.json`/`.omp/.mcp.json` only; machine-level
  OMP, Codex, Claude, Copilot, and other user/global MCP sources are never
  discovered. This is a sovereignty invariant like env scrubbing.
- OMP may mount non-core tools under xd://; absence from
  `getActiveToolNames()` does not mean absence from its tool registry.
- Force `memory.backend: "off"` (plus the legacy `memories.enabled` and
  `autolearn.enabled`) in the session settings overrides: ghost memory is plain
  files in the ghost home, and a stray memory key in read-only-loaded ghost
  settings would silently mount OMP's retain/recall/reflect tools and grow a
  second memory store outside the ghost home.
- Set `PI_NO_TITLE=1`: Ghost's smol lane owns the single persisted conversation
  title, so OMP's otherwise-native automatic title completion would duplicate
  work and race the same session-name slot.
- Tool approvals remain disabled (`yolo`/auto-approve); `ask` is never an
  approval prompt.
