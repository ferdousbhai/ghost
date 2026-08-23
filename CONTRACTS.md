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

- `GET  /api/ghosts` → `[{ name, dir, createdAt }]`
- `POST /api/ghosts` `{ name }` → creates `~/Ghosts/<name>/` with a seeded
  `character.md`
- `POST /api/ghosts/:name/messages` — the **pi-messages wire protocol**
  (request `{ model, context, options }` → SSE stream of pi-messages events).
  The pinned client in the summon-ghost repo is the normative spec
  (`~/github.com/ferdousbhai/summon-ghost`, read-only reference).
- `GET  /api/ghosts/:name/sessions` → session listing for that ghost. pi
  transcripts and Claude Code resume-metadata sidecars share the same response
  shape.

### Model indicator + switcher (which model a ghost uses, and switching it)

Provider models come from pi's own catalogue (`ModelRuntime`, which rides
models.dev via pi's vendored registry). One runtime entry is code-owned:
`claude-code/default`, representing the installed Claude Code harness rather
than an API model. Its usability comes from the boolean result of external
`claude auth status --json`; no credential is read into or emitted from a
response.

- `GET  /api/ghosts/:name/model` → the current selection:
  `{ current: { provider, id, name?, contextWindow?, hasVision } | null,
  source: "role" | "default" | "none" }`. `role` — `roles.chat_model` is set
  and resolves; `default` — pi's fallback (a hand-declared provider's first
  model, then the first available model); `none` — nothing usable, `current` is
  null. Resolved with the same logic session-host uses.
- `GET  /api/ghosts/:name/models?scope=available|catalog&provider=<id>&q=<search>&limit=<n>&offset=<n>`
  → `{ scope, models: [...], total, limit, offset, provider?, q? }`.
  - `scope=available` (default): models the ghost can use right now (from
    credentialed providers, via `getAvailable()`). Each row is
    `{ provider, id, name?, contextWindow?, cost?, hasVision, connectedVia?,
    current }`, tagged by `provider`, with `current: true` on the selected one.
    `connectedVia` is `oauth | api_key | claude_plan`.
  - `scope=catalog`: the FULL pi catalogue (`getModels()`, every provider,
    logged in or not), same row shape plus `usable: boolean` (is the provider
    credentialed; `connectedVia` present only when usable). Supports the
    `provider` filter and a case-insensitive `q` substring match on id/name.
  - Both scopes are paginated and sorted by `(provider, id)`: `total` is the
    full filtered count, `limit` defaults to 100 and is capped at 500, `offset`
    pages in. A single response never ships more than 500 rows, so the shell can
    search ~1,270 models by refining `q` rather than downloading them all.
- `PUT  /api/ghosts/:name/model` `{ provider, id }` → set `roles.chat_model`.
  Validates the model exists in the pi catalogue (`getModel`) or equals the
  code-owned `claude-code/default` runtime entry; an unknown model is a
  structured `400 unknown_model`. If the provider/runtime is not usable the
  write still happens and the response is `{ ok: true, usable: false, warning,
  current, source: "role" }` so the shell can prompt a login rather than the
  switch failing silently; a credentialed provider returns
  `{ ok: true, usable: true, current, source: "role" }`.

Requires `PUT` in the loopback CORS allow-list.

### Model login (`ghostd` drives pi's provider OAuth / api-key flows)

Signing a ghost into a provider is interactive and multi-step, so it is modeled
as a short-lived, pollable login session. Credentials are written by pi's own
`login()` to the ghost's `<home>/.pi/auth.json` and nowhere else; a pasted code
or key is never echoed in a GET body or a log.

- `GET  /api/ghosts/:name/providers` → `{ providers: [{ id, name, subscription,
  authTypes: ("oauth"|"api_key")[], loginLabel?, billingNote?, configured,
  connectedVia? }] }`,
  derived from pi's registry (openai-codex, openrouter, anthropic, github-copilot,
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

The pinned pi 0.84.2 documentation says its `anthropic` OAuth path uses
Anthropic extra usage billed per token; it is not the Claude-plan path below.

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

Bind to `127.0.0.1`. No auth in v1 (localhost trust); revisit before any
non-local exposure.

## Package boundaries

- `packages/extensions` — pure pi extensions + ghost-home fs helpers. No HTTP,
  no daemon lifecycle. Exports the extension factories and the ghost-home
  reader/writer.
- `packages/daemon` — per-ghost pi `AgentSession` and Claude Code query
  lifecycles, env scrubbing, model/runtime selection, the HTTP API, systemd
  unit. Depends on `extensions`.
- UI package: TBD (Omarchy shell technology decision pending).

## Known pi 0.84.2 gotchas (from the spike, scratchpad pi-spike-report.md)

- `createAgentSession({ agentDir })` does NOT redirect session storage — use
  `SessionManager.create(cwd, sessionDir)` or sessions land in global `~/.pi`.
- Scrub inherited env before session creation: stray provider API keys
  (e.g. `GEMINI_API_KEY`) silently add cloud models to a sovereign ghost.
- Parallel tool calls: wrap shared-file mutations in a file mutation queue.
- Tools should throw structured errors, not return `isError` payloads.
