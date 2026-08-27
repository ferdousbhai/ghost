# Contracts

The interfaces the packages build against. Change these deliberately, in one
commit, with every consumer updated.

## Ghost home (`ghost-home/v2`)

One directory per ghost. Plain files; anything derivable (memory index, doc
catalog) is derived per session and never stored.

The root is `~/ghosts` unless `ghostsRoot` says otherwise.

A ghost home is its own OMP extension package root, named explicitly by Ghost
whenever OMP discovers or rediscovers capabilities. That is what makes the
home's `skills/`, `agents/`, `commands/`, `rules/`, `prompts/`, `tools/`, and
`hooks/` load, so every artifact a ghost owns sits in plain sight beside
`character.md` rather than under a dot-directory. OMP's configured and
installed package roots are disabled for the session; the owner's global
skills, agents, and commands (`~/.agents`, `~/.codex`, `~/.claude`, and the
other capability providers) still arrive alongside. Re-entering the explicit
root scope for every rediscovery is load-bearing because the first MCP tool
refresh during startup causes OMP to discover skills again.

```
~/ghosts/<name>/
  character.md                 plain Markdown persona → system prompt
  docs/**/*.md                 first line `# Title`; optional final hashtag line
                               such as `#launch #product`
  memory/*.md                  atomic memory files: frontmatter description + updated,
                               body = the fact
  skills/<name>/SKILL.md       the ghost's own skills
  agents/<name>.md             the ghost's own subagents
  commands/<name>.md           the ghost's own slash commands
  rules/, prompts/, tools/, hooks/
                               the remaining OMP package-root artifact directories
  settings.yml                 the ghost's OMP settings
  models.json                  providers plus model roles and fallback chains
  mcp.json                     the ghost's MCP servers
  sessions/                    daemon-owned OMP transcripts and runtime sidecars
  sessions/pins.json           v2 pinned state: { "version": 2, "pinned": ["<id>", …] }
  sessions/reads.json          v2 read state: { "version": 2, "reads": { "<id>": "<ISO timestamp>" } }
  .pi/                         provider credentials and derived OMP machine runtime
  conversations/*.json         lossless source transcripts from the hosted export;
                               retained unchanged until that conversation is trashed
  export-manifest.json         present in imported archives; counts, pathRewrites,
                               notIncluded
```

`character.md` has no frontmatter. Its leading Markdown heading (`#` through
`######`) is the derived display title, while the complete Markdown body is the
persona injected into the system prompt.

Memory frontmatter is not duplicate presentation metadata. `description` is
the bounded synopsis used in the per-session memory index instead of injecting
every file body, and `updated` is the writer-stamped date that survives copies
and imports. Documents already keep their title in the leading `#` heading and
tags in a final hashtag line; legacy document frontmatter exists only at the
import migration boundary. OMP skill `name`/`description` fields remain the
upstream discovery contract.

What lives in a ghost home and what lives in the machine's own directories is
decided by lifecycle, not by which reads more natural. Mutable per-ghost state
stays in the home, because the home is the unit of atomic operation: rename and
delete are a single same-filesystem `rename(2)` under a filesystem-identity
lease, and a second store for the same ghost reintroduces orphans, split
consistency, and a crash window between the two moves. A write-once artifact of
using the machine goes where the machine puts that kind of artifact, carrying
attribution from the moment it is created, so it needs no migration when a ghost
is renamed. Secrets are the exception in the other direction: they belong in the
machine's secret facility, where locking is real and exclusion from an export is
structural rather than a rule somebody has to remember (#23).

Screenshots are the one thing a ghost produces that does not live in its home.
`ghost_screen` and `ghost_browser` write to the desktop's own screenshot
directory (`OMARCHY_SCREENSHOT_DIR`, else `XDG_PICTURES_DIR`, else
`~/Pictures`, matching `omarchy-capture-screenshot` and reading
`user-dirs.dirs` because a user unit inherits no XDG variables), named
`ghost-<ghost>-screen-<timestamp>.png` and `ghost-<ghost>-browser-<timestamp>.png`.
Retention keeps the newest captures per ghost and producer and deletes only
names matching that exact pattern, so the owner's own screenshots and another
ghost's captures share the directory untouched. Sharing the directory is a
deliberate exposure: a ghost captures far more often than a person does,
sometimes over a password manager, and `~/Pictures` is a common sync target
whose versioning keeps even the captures retention removed.

The same rule governs every write-once artifact a ghost produces, and the rest
of them do not exist yet. Downloads land in `XDG_DOWNLOAD_DIR` under the name
the page suggested, sanitised to a basename, deduplicated the way a browser
does; they are never pruned, because a download is a deliberate act with no
Omarchy retention convention to match, and their attribution lives in the
transcript rather than the filename. Recordings follow the screenshot pattern
exactly, and never prune the file currently being written.

Every document is ordinary Markdown in one canonical form:

```md
# Launch notes

The document body.

#launch #product
```

The first line is a non-empty level-one ATX heading and is the catalog title.
The optional final nonblank line is a space-separated list of lowercase tag
slugs matching `#[a-z0-9]+(?:-[a-z0-9]+)*`; `#archived` is reserved and removes
the document from the default working set. Derived `tags` exclude that reserved
status and deduplicate repeated slugs. The title and tag line remain part of the
Markdown file. Docs never use YAML frontmatter, and readers reject anything
outside this form after migration.

`docs/` is canonical. On import and daemon startup, the one-time `ghost-home/v1`
to `ghost-home/v2` migration first renames an unambiguous legacy `notes/`
directory to `docs/`, then rewrites every legacy document atomically. A
document's existing first H1 wins as its title, followed by legacy frontmatter
`title`, then its filename. Legacy tags become lowercase hyphenated hashtag
slugs, `archived: true` becomes `#archived`, and the import-only legacy `path`
field is discarded. A trailing hashtag line already in the body is merged and
deduplicated. An imported home's `export-manifest.json` is atomically promoted
from `ghost-home/v1` to `ghost-home/v2` with every other field preserved.
Each converted file is immediately valid v2, so a crash is recovered by
rerunning the scan; no marker or dual-format reader is kept. If
both `notes/` and `docs/` exist, startup still fails instead of guessing which
files win. Import rejects entries that collide after directory translation.
New homes and all writes produce only v2 docs.

Hosted conversation JSON is also a migration fixture, not the daemon's live
session store. `ghostd import` and daemon startup idempotently project each valid
`conversations/*.json` file into a native OMP transcript in `sessions/`, keeping
the conversation and message ids, roles, title, available message timestamps,
conversation created/updated times, readable text and attachments, and paired
tool calls/results. A missing message timestamp is placed deterministically
between the conversation timestamps; the export did not contain a value to
preserve. The source JSON is never rewritten during activation. An existing native
target always wins and is never overwritten; malformed fixtures remain in place
and are reported without preventing the ghost from starting. User-triggered
conversation deletion moves every valid source fixture for that conversation
to Trash before moving its native projection, so daemon restart cannot recreate
a conversation the owner removed.

`packages/daemon/src/hosted-conversation-import.ts` is therefore a second writer
of the OMP session format. Round-trip validation of its exact staged bytes
through `SessionManager.open` is the invariant that licenses this exception.
`CURRENT_SESSION_VERSION` comes from OMP's own exports, so a format bump breaks
loudly at import time.

`.pi/` holds live provider credentials, and OMP stores them unencrypted: the
`auth_credentials` row in `agent.db` is plain JSON behind nothing but 0600. That
is an acceptable posture for a file that never leaves the machine, and the whole
of it rests on that clause. **Nothing that copies a ghost home off this machine
may include `.pi/`.** There is no export path today, only import, so this is a
constraint on the one that gets built rather than a description of one that
exists. Ghost moves that store to Secret Service in #23.

A deleted ghost home leaves the root entirely, for the system trash; see the
`DELETE` route. That carries `.pi/` with it, so an owner who excludes
`~/ghosts` from a backup or sync tool has not excluded those credentials:
deleting a ghost currently makes them more likely to leave the machine, not
less. Nothing here fixes that; #23 does, by removing the plaintext store.

One naming convention makes the boundary readable rather than remembered. A
plain-named entry in a ghost home is part of that ghost's identity and travels
with it, including `settings.yml`, `models.json`, and `mcp.json`. A dot-prefixed
entry is bound to this machine and never leaves it: `.pi/` (credentials and
derived OMP runtime), `.browser-profile/` (cookies and logins), and `.trash/`.
Until #23 replaces inline secrets with Secret Service references, credential
values may still appear inside the otherwise portable `models.json` and
`mcp.json`; any future export must not copy those values as identity.

### Session capabilities

Ghost is owner-local by default: the owner is the only local caller, and every
session uses the same home, memory, docs, tools, and route behavior. The
session-scoped Remote voice and collaboration routes below are the only
deliberate exceptions. They are explicitly initiated off-machine capabilities
and never broaden another ghost or conversation.

A session is OMP-native. Ghost keeps OMP's discovery and the operating half of
its system prompt, then appends the Ghost persona and derived memory/doc
sections.

Deliberate subtractions from the harness prompt. The persona extension removes
`§ Role`, `§ Workflow`, `§ Delivery`, and `§ Critical`: the first casts the
model as a coding assistant and sets its voice twenty thousand characters
before `character.md` is reached, and the rest are the rules of a coding task,
which a conversation is often not. None of the four has a setting.
`personality: "none"` drops the voice rules that do. `tools.xdevDocs: "catalog"`
moves the built-in device schemas (`ast_edit`, `debug`, `lsp`, `inspect_image`)
out of the prompt, leaving the catalog that names them and one `xd://<name>`
read before first use.

What stays is everything about operating the machine: `§ Runtime` with its
skills, rules, and internal URLs, the tool inventory, and `§ Tool Policy`. A
seeded ghost's first turn carries about 10.2k characters of system prompt where
it carried 23.8k.
Native filesystem and search (`read`, `glob`, `grep`), mutation (`write`,
`edit`), Bash, web search, task/hub subagents, background jobs, skills, rules,
project context, extensions/plugins, commands, and the ghost home's own project
MCP remain available under OMP's normal xd:// presentation. MCP is a deliberate
sovereignty exception to OMP's normal multi-source discovery: an OMP
session loads only `<ghost>/mcp.json` and
never discovers or loads user/global OMP config or another coding agent's MCP
config (`~/.codex`, `~/.claude`, `~/.copilot`, and similar). The owner's
global instructions are the other exception, in the opposite direction: OMP
surfaces exactly one user-level context file, the highest-priority provider's,
and Ghost disables `context-file:user:CLAUDE.md` so that file is
`~/.agents/AGENTS.md` rather than `~/.claude/CLAUDE.md`, whose contents are
written to tell a model it is a coding agent. Project-level context files stay
untouched. Ghost otherwise
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

Slash-command discovery is session-scoped and comes from OMP's
`buildAvailableSlashCommands`, including builtins, skills, extensions, custom
commands, MCP prompts, and project file commands. Ghost annotates each result
as `available`, `partial`, or `unsupported`: only explicitly admitted
informational builtin forms execute through OMP's headless handlers. Every
known but unsupported builtin — including TUI-only commands and commands that
conflict with Ghost's memory, browser/computer, MCP, conversation, or fixed-home
contracts — is consumed before `AgentSession.prompt()` and reported as
`command_output`. It is never sent to a model as ordinary slash-prefixed text.

`!command` executes immediately through OMP's session-aware Bash runner without
a model turn. `!!command` does the same but excludes the result from future
model context. Both appear in the live event stream and are
persisted in an OMP transcript; a successful standalone `cd` changes the
conversation working directory without relocating that transcript.

Long-context maintenance is OMP-native. The daemon projects its owner-facing
`compaction.enabled`, `thresholdTokens`, and `thresholdFraction` settings onto
OMP's enablement and fixed/percentage thresholds, always enabling OMP's
asynchronous speculation. A fixed token threshold takes precedence; otherwise
the default is 80% of the active model's window. This deliberately replaces the
former `min(80% of window, 100k)` threshold with a model-relative policy that
continues to fit when OMP changes models. Ghost no longer caps the trigger, so
on a very large context window a conversation now runs further before it
compacts than it did under the 100k ceiling; that is OMP's policy and Ghost
does not re-create the cap. Ghost contributes only the summary
instructions through `session.compacting`; OMP owns speculative and mid-turn
maintenance, keep-recent/reserve behavior, history estimates and pruning, and
overflow compact-and-retry.

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
- `POST /api/ghosts` `{ name }` → creates `~/ghosts/<name>/` with a seeded
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
  title work is awaited first. **Deletion is a move, never an `rm`**:
  the ghost home holds the only copy of a persona, its memory, and its docs, so
  nothing on any path follows the rename with a recursive removal.
- `PUT  /api/ghosts/:name/name` `{ name: "<new>" }` → `{ ok: true, name }` — the
  ghost's name IS its home directory's name, so renaming one is anchored by a
  same-filesystem rename of `<root>/<old>/` to `<root>/<new>/`. Persona, memory,
  docs, conversations, pins, and credentials are inside the directory that
  moved; every conversation id stored with its transcript stays valid,
  and every other route's `:name` changes with it. `character.md` is the ghost's
  own words and is never touched. The one exception is a character file
  byte-equal to the daemon-authored seed: it is re-rendered in canonical
  Markdown under the new name. That replacement is staged beside the character
  file before the home moves and published atomically afterwards; a staging
  failure moves nothing, and a publish failure rolls the home move back. Checked
  in this order: the new name gets the same validation
  `POST /api/ghosts` applies (`400`); an unknown ghost is `404 not_found`;
  renaming to the ghost's current name is a no-op `200`; a name already taken in
  the root — by a ghost or by anything else — is `409 already_exists`; a ghost
  with any conversation busy, opening, or mid-delete is `409 ghost_busy`, the
  same gate `DELETE` uses, as is a second concurrent rename or delete. Idle
  hosted sessions are closed and pending title work awaited first, so nothing
  holds a path under the old name across the rename. A Claude Code conversation
  keeps its resume sidecar, but that runtime stores the transcript itself under
  its own `~/.claude/projects/<cwd>` path, which does not move with the home.
- `GET  /api/ghosts/:name/context` → `{ character, docs, memory, agents,
  skipped }` — the owner's browseable ghost context and OMP capabilities,
  derived from disk for each request and never stored. `character` is
  `{ path: "character.md", title }`, where `title` is derived from its leading
  Markdown heading. `docs` contains
  `{ path: "docs/<relative>.md", relativePath, title, tags, archived }`, derived
  from the document's first H1 and optional final hashtag line. `memory`
  contains `{ path: "memory/<slug>.md", slug, description, content, updated }`.
  `agents` contains the OMP task helpers available under the same project,
  user, extension, bundled, precedence, and `task.disabledAgents` rules as a
  live session, normalized to `{ name, description, source, tools, model,
  spawns }`. `tools: null` means the helper keeps the available session toolset,
  and a list restricts it to those tools. An empty `model` list means the helper
  inherits the active model. `spawns: null` means it cannot delegate further,
  `"*"` allows any available helper, and a list allows only those named helpers.
  System prompts and agent file paths are never returned. `skipped` reports
  malformed doc or memory files as `{ section, path, reason }` without
  hiding the valid siblings. The returned file paths are ghost-home-relative;
  a client already gets that home's absolute `dir` from `GET /api/ghosts`.
- `DELETE /api/ghosts/:name/context`
  `{ section: "docs"|"memory", path, confirm: path }` →
  `{ ok: true, path, trash, kind }` — moves exactly one Markdown file under the
  named section to recoverable Trash. `confirm` must byte-match `path`; absolute
  paths, traversal, non-Markdown paths, directories, `character.md`, and helper
  definitions are refused. A symlink is moved as a symlink and never followed.
  The ordinary destination is the freedesktop home Trash; cross-filesystem
  moves fall back to `<ghost>/.trash/`, still by rename rather than copy/unlink.
- `GET  /api/ghosts/:name/mcp` → `{ servers, skipped }` — the effective
  ghost-only MCP configuration from `<ghost>/mcp.json`. It never scans ambient
  OMP, Codex, Claude, Copilot, or other agent configuration. Each
  valid server is `{ name, enabled, source, path, config, connectionStatus }`.
  `config` is deliberately lossy: header/environment key names and counts may
  be shown, but their values, command arguments, OAuth/auth credentials, URL
  userinfo, and query values never cross HTTP. Non-secret placement/policy
  fields (`cwd`, `envPolicy`, and `headerPolicy`) do cross so replacement edits
  preserve the server's execution semantics. `connectionStatus` is
  `connected`, `connecting`, `disconnected`, `mixed`, `disabled`, or
  `not_loaded`; GET only inspects already-open OMP conversations and never
  opens one. Malformed files/rows appear in `skipped` without hiding valid
  siblings.
- MCP mutations use OMP's locked atomic project-config writer and return the
  refreshed sanitized snapshot: `POST /api/ghosts/:name/mcp`
  `{ name, config }` adds to `mcp.json`; `PUT|DELETE
  /api/ghosts/:name/mcp/:server` replaces/removes the named entry;
  `PUT …/:server/enabled` `{ enabled }` toggles it. Every mutation reloads all
  open OMP conversations for the ghost. An idle session reconnects and replaces
  its mounted MCP tools immediately; a busy session coalesces changes into one
  reload after the turn settles. Thus adding the first server mounts tools, and
  updating, disabling, or removing one cannot leave stale tools selected.
  Model and MCP mutations take a filesystem-identity operation lease before
  resolving any home path. Whole-home rename/delete first block new leases and
  drain admitted mutations before sessions are quiesced and the directory
  moves, so an awaited runtime or config writer cannot recreate the old name.
- `POST …/mcp/:server/test` runs an isolated no-session connection probe and
  returns a sanitized `result` with status/tool count; transport error text is
  not returned because it may echo secrets. `POST …/mcp/:server/reconnect`
  manually retries already-loaded live managers without opening a conversation;
  it reports `not_loaded` when none exists and `deferred` when one is busy.
- `POST /api/ghosts/:name/messages` — the **pi-messages wire protocol** over
  OMP's `AgentSession` (request `{ model, context, options }` → SSE stream).
  The pinned client in the summon-ghost repo is the normative spec
  (`~/github.com/ferdousbhai/summon-ghost`, read-only reference).
- A conversation has two distinct identifiers at this API boundary.
  `conversationId` is the runtime-owned resume id and is passed unchanged as
  pi-messages `options.sessionId`. `id` is the opaque public row/action id,
  qualified as `pi:<conversationId>` or `claude-code:<conversationId>` so two
  runtimes may own the same raw id without colliding. Every `:id` session action
  below requires the qualified public id returned by the listing; unqualified
  legacy action ids are `400 invalid_conversation_id`. The runtime prefixes are
  the dispatch boundary, not part of the resume id. Pi transcript filenames are
  safe implementation details: an id that cannot be used directly as a bounded
  filename is mapped to a reserved hash name and stored exactly in native
  transcript metadata. Listing and resume recover that exact id; a generated
  filename stem is never an alternate resume id for the same transcript.
  Legacy transcripts with no identity metadata keep their existing filename
  stem as their sole raw id. An unsafe id sanitized by the pre-milestone writer
  cannot be reconstructed; sending that original id after upgrade creates a
  distinct correctly bound conversation instead of aliasing the legacy row.
  A raw resume id contains 1–200 Unicode scalar values. Empty ids, ids over
  that scalar-value bound, and JavaScript strings containing an unpaired UTF-16
  high or low surrogate are `400 invalid_conversation_id`; ids are never
  truncated, normalized, or repaired. A valid astral character counts as one
  scalar value. The same grammar applies inside every runtime-qualified action
  id and to stored Pi identity metadata.
- `GET  /api/ghosts/:name/sessions` → `{ sessions: [{ id, conversationId,
  runtime, title, createdAt,
  updatedAt, messageCount, pinned, unread }] }` — the ghost's conversations, **pinned
  first, then newest-updated first within each group**. `runtime` is `"pi"` or
  `"claude-code"`;
  `title` is a short auto-generated name or `null` until one is generated (see
  "Conversation titles" below). OMP transcripts and Claude Code resume sidecars
  share this shape (a Claude conversation's `title` is `"Claude Code"`).
- `GET  /api/ghosts/:name/events` → an SSE stream of
  `{ type: "conversation-updated", id, conversationId, runtime, updatedAt }`
  invalidations. The daemon
  emits one after persisted conversation or read-state changes; clients refetch
  `GET …/sessions` rather than receiving a duplicated listing on this stream.
  It uses the same SSE headers and 15-second comment keepalive as turn streams.
  Disconnect or abort unregisters the listener and keepalive immediately, and
  subscribing never opens or retains an agent session.
- `PUT  /api/ghosts/:name/sessions/:id/pin` `{ pinned: boolean }` →
  `{ ok: true, pinned }` — pin or unpin one conversation, idempotently. Pin
  state lives in `sessions/pins.json` (atomic replace, never partial), works
  for OMP and Claude Code conversations alike, and is owner state, not derivable
  — one of the two deliberate owner-state exceptions in the daemon-owned dir.
  Version 2 stores public qualified ids. A version 1 file with raw ids applies
  each raw id to every currently matching runtime row and is migrated to version
  2 on the next owner-state mutation.
  A non-boolean
  `pinned` is `400 invalid_request`; an unknown conversation id is `404 not_found`.
  Deleting a conversation drops its pin; a stale id (conversation gone) is
  ignored on read and pruned on the next write.
- `PUT  /api/ghosts/:name/sessions/:id/read` `{}` →
  `{ ok: true, readAt }` — mark a stored conversation opened using the daemon's
  clock. Read state lives in `sessions/reads.json` as conversation id to
  last-opened ISO timestamp (atomic replace, never partial), works for OMP and
  Claude Code conversations alike, and is owner state rather than something a
  transcript can derive. Version 2 stores public qualified ids. A version 1
  raw-id entry applies to every currently matching runtime row and is migrated
  to version 2 on the next owner-state mutation. A row is unread when it has
  `updatedAt` is later than `readAt`. An unknown conversation id is
  `404 not_found`; deletion drops its read entry, and stale ids are pruned on
  the next write.
- `PUT  /api/ghosts/:name/sessions/:id/title` `{ title: string }` →
  `{ ok: true, title }` — rename one conversation. The title is trimmed and
  written through the same native title slot the smol lane uses, with source
  `"user"`: OMP refuses an automatic title over a name a person chose, so a
  rename is never undone by the background titler. `title` in the response is
  the name as stored — OMP collapses control characters and runs of spaces. A
  non-string title, a title that is empty after trimming or contains nothing
  printable, or one over 120 characters is `400 invalid_request`; an unknown
  conversation id is `404 not_found`; a Claude Code conversation is
  `409 not_supported`, because that runtime owns its own conversation's name.
  Renaming works while a turn is streaming — the title slot is not part of the
  conversation tree.
- `GET  /api/ghosts/:name/sessions/:id/commands` → `{ commands }` — OMP's live
  command catalog for that conversation, rebuilt with
  `buildAvailableSlashCommands` so cwd-scoped file commands, skills,
  extensions, custom commands, and MCP prompts remain current, then augmented
  from OMP's unified registry with TUI-only builtins marked `unsupported`.
  Rows preserve
  OMP's `name`, `aliases`, `description`, `input`, `subcommands`, and `source`,
  plus Ghost's `availability` and optional `unavailableReason`. A busy
  conversation returns `409 session_busy`; a ghost currently routed through
  Claude Code returns `409 not_supported`, because opening an unrelated OMP
  session just to discover commands would lie about the active runtime;
  non-GET methods return `405`.
- A standalone builtin sent through `POST …/messages` produces exactly
  `start`, one or more `command_output` events, then `done` with zero usage.
  Unsupported and failed commands set `isError` and `code` on their output but
  still use `done`: the command completed without a transport or model error.
  Command output is not an assistant message and is not persisted as one.
- `DELETE /api/ghosts/:name/sessions/:id` →
  `{ ok: true, trash: [{ artifact, source, trash, kind }, …] }` — moves every
  Ghost-owned artifact for the conversation to recoverable Trash. Hosted-import
  source fixtures move first, followed by the OMP transcript and/or Claude Code
  resume sidecar; this order prevents startup from resurrecting a removed
  projection. `artifact` is `hosted-source`, `omp-transcript`, or
  `claude-sidecar`. Claude Code's actual transcript remains in that runtime's
  external `~/.claude` storage; Ghost does not claim to delete it. An active
  turn or live-voice session must finish or be stopped first
  (`409 session_busy`); an unknown conversation returns `404 not_found`.
  Failed fork rollback is the sole permanent-unlink path: the fork was never
  published to the owner and must not pollute Trash.
- `GET|POST /api/ghosts/:name/sessions/:id/live` owns OMP realtime voice for
  one conversation. GET returns `{ supported, active, phase, muted, inputLevel,
  outputLevel, transcript, error? }` without opening a session. POST accepts
  `{ action: "start"|"mute"|"unmute"|"stop" }`. Start uses the machine's
  microphone and OMP's Codex Realtime transport with the ghost's Codex OAuth;
  audio and live transcript therefore leave the machine for OpenAI. Delegated
  work still runs through that conversation's ordinary AgentSession and tools.
  A separate chat or direct Bash turn is refused from the moment voice startup
  claims the conversation until voice has fully stopped. Model rebinds and MCP
  reloads/reconnects defer across that same boundary and apply after voice
  releases the session. Claude Code returns `409 not_supported`.
- `GET|POST /api/ghosts/:name/sessions/:id/collab` owns one OMP encrypted relay
  host. GET returns `{ supported, active, readOnlyUrl?, writableUrl?,
  participants }` without opening a session. Start is
  `{ action: "start", relayUrl?, writable, confirmed }`; stop is
  `{ action: "stop" }`. The room key is fragment-carried and session frames are
  AES-GCM encrypted. A read-only start never returns the write-token URL. A
  writable start requires `confirmed: true` and returns a distinct capability:
  its holder may prompt or interrupt the model and thereby run the host ghost's
  tools with the host's local authority. Links are never logged or copied
  automatically. At most one host startup is admitted per conversation;
  concurrent starts coalesce, while stop, conversation close, and daemon
  shutdown wait for an admitted startup before stopping it. The host is
  conversation-scoped and is stopped when that session closes. Claude Code
  returns `409 not_supported`.
- `GET  /api/ghosts/:name/sessions/:id/transcript` → `{ id, conversationId,
  runtime, title, messages, total, truncated }` — a past conversation's history
  so the shell can rehydrate
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
  A tool call whose persisted result was an error also carries `failed: true`;
  the result messages themselves are dropped here, and without that bit a
  rehydrated transcript would show every recovered call as having succeeded.
  Its absence means "not known to have failed" — a call with no result at all
  (an abandoned turn) carries nothing.
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
  deadline (`askTimeoutSeconds`, default 120; `0` waits forever) and on expiry
  settles the question so the turn can continue, which is what keeps a
  conversation from stalling on a question nobody is there to answer. What it
  settles as depends on the question: one that named a `recommended` option
  submits that option, because it is the asking model's own pre-committed
  default. One that named none submits **no selection at all** — an answer
  picked by list position would reach the model as a decision the owner never
  made — leaving the model to take the careful branch or park the task. Either
  way the result is marked as a timeout, which is what
  `settled: "timedOut"` on the restored ask card is derived from, so an expiry
  is never mistaken for an owner's answer. A client can therefore find an ask
  gone that it never answered: `GET` returns `null` and `POST` is
  `409 ask_not_pending`, which means settled rather than broken. The clock
  starts when the question is presented, not when the model asked it, so a slow
  turn does not spend the budget before anyone can see it.

  The deadline is daemon-wide rather than per-ghost: how long a dialog waits is
  a property of the person at the keyboard, not of the persona asking, and a
  ghost home holds only what makes that ghost that ghost. Sessions carry it as
  OMP's own `ask.timeout` setting, so OMP resolves it once, above a ghost home's
  own settings and beneath the two things only it knows: a question that names
  its own `timeout` keeps it, and plan mode suspends auto-answering entirely.
- `GET|POST /api/ghosts/:name/sessions/:id/queue` reads or enqueues OMP's
  native mid-turn queues. POST is `{ mode: "steer"|"followUp", text }`:
  steering enters the active run, while follow-up runs after it.
- `POST /api/ghosts/:name/sessions/:id/branch` with `{ action: "fork",
  entryId }` → `{ id, conversationId, runtime, sessionId, title, draft,
  transcript }` — branching off is a
  **copy, not a rewind**. The conversation's transcript is forked into a new one
  (pi's `SessionManager.forkFrom`, whose header records `parentSession`), the
  copy is rewound to just before `entryId`, and that user message's text comes
  back as `draft` for the composer. `id` is the new public action id;
  `conversationId` and the compatibility alias `sessionId` are its raw resume id,
  already in `GET …/sessions`; `transcript` is its rewound history. The source
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
completion, fire-and-forget: it never blocks the reply and a failure is logged,
never fatal. A conversation is titled once
and never re-titled. A fork is named at fork time instead, the way a file
manager names a copy: `<source title> (n)` for the smallest free `n` from 2 up,
with any trailing ` (k)` stripped from the base first, so a fork of a fork does
not stack suffixes. An untitled source forks to an untitled conversation. The title is stored through OMP's native fixed-width
**`title` slot** at the start of the conversation's own `sessions/*.jsonl`
transcript, with its append-only `title_change` audit entry. It never enters the
model's context, needs no sidecar, and rides the same per-ghost storage backup
and future encryption cover. `GET …/sessions` surfaces it as `title`. A
pre-OMP-18 transcript instead carries pi 0.84's appended `session_info.name`;
the daemon reads that title immediately and promotes it to the native OMP slot
on the conversation's next writable open, without generating a replacement.

The owner's own name for a conversation goes into the same slot, with the
source set to `user` (`PUT …/title`). That source is the whole arbitration: the
generated title and the pi 0.84 promotion are both automatic writes, and OMP
refuses an automatic title over a name a person chose.

**Greetings.** `POST …/greeting` (above) writes the empty-chat opener with one
smol completion: 1-3 sentences in the ghost's own voice, at most one timely
detail (time of day, a gap since the last conversation, something from memory),
ending with an invitation to talk. Character, memory-index, and doc-catalog
inputs are fenced as untrusted data; output that answers instead of greeting is
rejected outright, never truncated.

Which model serves the lane is the `smol_model` role in `models.json`,
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
  and resolves among usable models; `default` — OMP's fallback: resolve the
  projected default role, then choose the first provider-declared default in
  availability order, then the first available model; `none` — nothing usable,
  `current` is null. This is the same initial resolution
  `createAgentSession` performs for a fresh conversation.
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

`GET /api/ghosts/:name/model-routing` returns `{ roles }` for every OMP built-in:
`chat_model` (`default`), `smol_model`, `slow_model`, `vision_model`,
`plan_model`, `designer_model`, `commit_model`, `tiny_model`, `task_model`, and
`advisor_model`. The older custom `general_purpose_model` and `research_model`
rows remain visible only when an existing home has configured a primary or
fallback for them. Each row is `{ role, ompRole, label, primary, effective,
source, fallbacks }`: `primary` is the configured model, `effective` includes
OMP's automatic role resolution, and `source` is `explicit`, `auto`, or
`unavailable`. Models and fallbacks carry resolved/usable status.

`PUT /api/ghosts/:name/model-routing` accepts `{ role, target, provider, id }`
with `target: "primary" | "fallback"`; `{ role, target: "clear_primary" }`
removes an explicit primary, revealing automatic resolution; and `{ role,
target: "replace_fallbacks", fallbacks: [{ provider, id }, …] }` atomically
replaces, removes, or reorders the complete retry chain. The older
`clear_fallbacks` target remains accepted as an empty-chain compatibility form.
Vision primaries/fallbacks must accept images. `claude-code/default` is valid
only as the primary chat runtime because it is not an OMP provider model.

Ghost persists this in `models.json` under `roles` and `fallbacks`, then
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
bound. `succeeded` is not published until the daemon has invalidated and rebuilt
the cached OMP credential/model state for that ghost. Idle conversations update
before the terminal login view is visible; a conversation with an active turn,
live voice, or another exclusive owner records one coalesced refresh and applies
it at that owner's release boundary, never by changing credentials mid-turn.
Abandoned logins time out and are cleaned up server-side.

A live login belongs to the ghost home's filesystem identity, not to the
directory name captured when it started. Renaming the ghost therefore changes
the login routes to the new `:name` without interrupting the provider flow;
OMP's already-open credential store follows the same home move, so the
credential and any default model binding land in the renamed home. Deleting a
ghost cancels and forgets its live logins; reusing the deleted name cannot adopt
one because it is a different home.

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
metadata sidecar under `sessions/`, emits one terminal event, and closes the
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
- Sessions omit non-MCP capability-provider restrictions, explicitly scope
  every artifact discovery to the ghost home, and load read-only settings from
  that home's `settings.yml` only. Their MCP manager is injected from that
  ghost's `mcp.json` only; machine-level OMP, Codex, Claude, Copilot, and other
  user/global MCP sources are never discovered. This is a sovereignty invariant
  like env scrubbing.
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
