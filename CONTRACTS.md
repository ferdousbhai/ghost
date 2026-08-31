# Contracts

The interfaces the packages build against. Change these deliberately, in one
commit, with every consumer updated.

## Ghost home (`ghost-home/v2`)

One directory per ghost. Plain files; anything derivable (memory index and
machine Documents index) is derived per session and never stored.

The root is `~/ghosts` unless `ghostsRoot` says otherwise.

A ghost home is the primary user-level resource root a session sees, named
explicitly by Ghost whenever it builds a declarative snapshot. Its plain `skills/`, `agents/`,
`commands/`, `rules/`, `prompts/`, `tools/`, and `hooks/` remain ghost-owned
files. Its declarative snapshot admits only those visible directories plus
visible `AGENTS.md`/`CLAUDE.md`; hidden `.agents`, `.claude`, `.pi`, and `.omp`
compatibility providers are project-only and are never user-level aliases
inside a ghost home. The daemon resolves the declarative categories into an
immutable session snapshot and passes the ghost's absolute extension roots
explicitly. It never lets the operational cwd become an implicit package root.
Owner-home or project executable extensions, hooks,
TypeScript commands, and custom code tools are disabled in a Ghost principal
session. A deliberately bound project's data-only instructions, skills, rules,
and MCP join the principal context. Markdown prompts and commands remain pinned,
previewable owner data but are not interpreted by a principal harness; native
coding harnesses discover their own project resources at the delegated cwd.
Machine skills are the one ambient declarative exception: Ghost uses
pi's native skill parser to snapshot every valid skill visible under the owner's
`~/.agents/skills/` and `~/.pi/agent/skills/`, following the symlinks those
standard machine roots commonly contain. Omarchy owns its package paths and
maintains links for every shipped skill in those standard roots; Ghost carries
no Omarchy-specific file or directory path. Native realpath deduplication and
name validation apply. Machine skills enter at session construction with lowest
name precedence, before ghost-home and then project resources; no hardcoded
skill-name allowlist exists. This owner-trusted machine discovery is deliberately
outside the descriptor-confined project scanner. A Ghost principal delegates
through the daemon-owned `task` tools described below. Ghost does not parse,
merge, or execute agent definitions: the selected native coding harness owns
its user, plugin, and project agent registry at the task cwd. The narrow Claude
inventory described below asks that harness for selectable names/models without
reading definitions. Ghost-home
and project agent files remain previewable principal resources only where an
existing scanner already reports them; they do not form a Ghost registry. A
native Claude task retains Claude Code's own subagents; the Claude principal
does not expose native `Agent` or legacy `Task`, because those would bypass the
durable Ghost task boundary.

```
~/ghosts/<name>/
  character.md                 plain Markdown persona → system prompt
  memory/*.md                  one concise fact per plain Markdown file
  skills/<name>/SKILL.md       the ghost's own skills
  agents/<name>.md             reserved custom agents (preview-only to the principal)
  commands/, prompts/         retained owner data; preview-only to the principal
  rules/, tools/, hooks/      the remaining ghost-owned artifact directories
  settings.yml                 the ghost's own plain YAML mapping; Ghost reads
                               `ttsr.disabledRules`; the unsupported legacy
                               collaboration seam still parses
                               `collab.relayUrl` and `collab.webUrl`
  models.json                  providers, allowed keyring accounts, model roles,
                               and fallback chains; secrets are references only
  mcp.json                     the ghost's MCP servers; secrets are references only
  sessions/                    daemon-owned pi transcripts and runtime sidecars
  sessions/<stem>.<runtime>.project.json
                               conversation project root, actual cwd, immutable
                               resource summary, status, generation
  sessions/<stem>.pi.project-snapshot.<generation>.json
                               exact admitted Pi project instructions/resources/MCP
  sessions/<stem>.pi.tool-cwds.json
                               bounded execution-time cwd by persisted Pi tool-call id
  sessions/<stem>.<runtime>.maintenance.json
                               v1 idle-memory journal for one runtime-qualified
                               conversation, including ordered consolidation
                               mutations; never copied to another conversation
  sessions/<stem>.<runtime>.presentation.json
                               v1 bounded owner/assistant presentation history
                               for one runtime-qualified conversation
  sessions/pins.json           v2 pinned state: { "version": 2, "pinned": ["<id>", …] }
  sessions/reads.json          v2 read state: { "version": 2, "reads": { "<id>": "<ISO timestamp>" } }
  .tasks/                      daemon-owned normalized worker-task lifecycle
  .tasks/task-<uuid>.json      v3 bounded task/workspace state and event tail;
                               the coding harness retains its own full native transcript
  .pi/                         derived pi machine runtime; never credentials
  .pi/models.pi.json           secret-free provider/models view synced from
                               models.json
  .pi/models-store.json        pi's catalogue cache
  .memory-maintenance.json     v1 machine-bound last consolidation-run time
```

The presentation file is Ghost-owned display state, never runtime resume state.
Pi's native transcript and Claude Code's native transcript plus Ghost resume
sidecar remain authoritative for model context and continuation. The mode-`0600`
file embeds its exact runtime and raw conversation id and is named from the
same collision-safe conversation stem as the other runtime sidecars; the stem
is never accepted as an alternate id. Version 1 is one atomically replaced JSON
object with monotonically sequenced settled owner turns, the native source
revision, a positive native owner-turn ordinal, final outcome and timestamp,
optional title state, and explicit truncation/migration metadata. The ordinal
detects a native-commit/presentation-commit crash gap even when Pi's leaf ids
are opaque: a jump marks the unavailable journal prefix, while an equal ordinal
with a different revision or a lower ordinal is rejected. Owner and assistant
text are each bounded to 32,000 UTF-16 code units, at most 1,000 newest turns
are retained, and the full file is at most 16 MiB. Old turns are evicted
deterministically and the state records the greatest dropped sequence. An exact
repeat of the newest owner ordinal and native source revision is idempotent;
an older ordinal is rejected. Every read validates the complete shape, bounds,
contiguous sequence, source-revision/runtime match, embedded identity,
regular-file identity, one link, and mode before use.
Mutations serialize per file and publish through temporary-file fsync, rename,
and parent-directory fsync, so a crash exposes the complete old or new version.
An interrupted owner action with no natively persisted final assistant turn is
not added. Existing Pi and Claude conversations are not imported or rewritten:
the first later record identifies whether presentation history before that
point is omitted. A presentation file alone never publishes a conversation in
the session list.

`character.md` has no frontmatter. Its leading Markdown heading
(`#` through `######`) is the derived display title, while the complete
Markdown body is the persona injected into the system prompt. The body is at
most 20,000 JavaScript UTF-16 code units. Tool writes and direct home writes
reject a larger body, and a larger hand-edited file fails session construction
rather than being truncated into the prompt.

Memory files have no frontmatter and no required heading. Their complete
Markdown content is the fact. The per-session index is one file name per line
and nothing else: the slug is what says what a fact is about, so the writer's
instructions ask for a name that does. It orders files by modification time
descending, then slug ascending, and admits only complete lines through its
4,000-character budget, so the stalest facts fall out first. Index lines are
fenced as untrusted data. The memory API returns `updated` as the file's full
ISO modification timestamp.
One file is at most 2,000 JavaScript UTF-16 code units of content and 6,001
on-disk bytes, inclusive; the byte ceiling is the worst-case canonical UTF-8
content plus the writer's final newline. Every list, direct read, and exact
maintenance receipt/replay read opens the final entry with
`O_NOFOLLOW|O_NONBLOCK`, admits that byte size before allocation, reads through
the pinned regular-file descriptor, decodes fatal UTF-8, and verifies the
descriptor and live pathname stayed identical. Unsafe or over-limit entries
are reported as skipped by listings; a direct or receipt read fails rather than
truncating, replacing bytes, or treating invalid state as absence.
Every `GhostHome` memory write first redacts PEM private-key blocks, common
`sk-`, GitHub, Slack, bearer, and named key/token/secret/password credential
forms to `[REDACTED_SECRET]`, then validates and serializes the redacted text.
The limit therefore applies to what reaches disk, and the session writer,
idle updater, and consolidation writer share one secret boundary. An omitted
slug is derived from that redacted text, so credentials cannot escape through a
filename.

`GhostHome.deleteMemory` accepts only one valid memory slug and moves that
descriptor-pinned regular Markdown file by same-filesystem rename into the
ghost's `.trash/`. It shares the whole-memory-directory mutation queue and
descriptor lock used by writes. The first destination is `<slug>.md`; an
existing destination makes the writer choose `<slug>-2.md`, then the next free
numeric suffix, without replacing trash. The pre-rename delete intent records
the exact source bytes and SHA-256 plus that collision-free relative trash
name. This private lifecycle trash is distinct from the owner-facing memory
route's freedesktop Trash result.

Canonical ghost-home Documents already keep their title in the leading `#`
heading and tags in a final hashtag line; legacy document frontmatter exists
only at the import migration boundary. Skill `name`/`description` frontmatter
fields remain pi's discovery contract.

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

The owner's live Documents are neither per-ghost state nor write-once ghost
artifacts. They are one owner-wide mutable tree shared by every session, rooted
at `XDG_DOCUMENTS_DIR`, else `XDG_CONFIG_HOME/user-dirs.dirs`'s
`XDG_DOCUMENTS_DIR`, else `~/Documents`. The root is absolute and canonical.
It stays outside every ghost home and is therefore excluded from ghost rename,
delete, and any ghost-home export. There is one owner and one Documents tree;
Ghost does not create per-ghost partitions, import roots, or path mappings
inside it.

A trusted project is likewise owner/machine-wide live data, not ghost state.
Ghost stores only a conversation's canonical root/cwd reference and immutable
resource summary in its sidecar. Ghost rename, delete, and future export move or
remove that sidecar with the conversation but never rename, delete, copy, or
export the referenced project tree. The machine-local trust ledger is excluded
from ghost-home export and remains when one ghost or conversation is removed;
trust says this OS owner confirmed this filesystem identity, not that a persona
owns the directory.

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

The same rule governs every write-once artifact a ghost produces. Downloads are
not one of them: Ghost drives the owner's own Chromium, so a download is the
browser's, landing wherever the owner configured it and deduplicated by the
browser itself. Recordings do not exist yet; when they do they follow the
screenshot pattern exactly, and never prune the file currently being written.

### Scheduled work

Scheduled work is a systemd user timer, and the timer is the only record of it.
Ghost ships no scheduler: a ghost writes its own units through Bash, the way
`omarchy-games-retro-install` writes one `.desktop` file into the standard user
directory and stops. At daemon composition, Ghost resolves one absolute user
unit directory: `$XDG_CONFIG_HOME/systemd/user` when `XDG_CONFIG_HOME` is
absolute, otherwise `~/.config/systemd/user`. Pi and Claude prompts, deletion,
and rename diagnostics all use that same value; none re-read the environment.

The pair is named
`ghost-timer-v1-<ASCII ghost-name length>-<ghost>-<slug>.timer` and `.service`.
The length field makes ownership prefix-free: `aria` cannot claim `aria-ops`.
The slug is 1–64 characters matching `[a-z0-9]+(?:-[a-z0-9]+)*` — lowercase
ASCII letters and digits separated only by single hyphens. The original
unversioned `ghost-timer-<ghost>-<slug>` form is ambiguous and therefore outside
Ghost ownership: it is ignored, never inferred or automatically migrated.
The service's `ExecStart` is the `ghost` CLI, which authenticates itself from
the API token file. `TimeoutStartSec` must be lifted, because a `oneshot`
inherits systemd's ~90s start timeout and the daemon aborts a turn whose caller
disconnects, so a longer check-in would otherwise be killed mid-answer.

That versioned, length-delimited prefix plus the slug grammar is the entire
daemon-side ownership contract. Deleting a ghost disables and removes only
matching current-version units, so the owner's own timers, another ghost's, and
all legacy ambiguous units share the directory untouched. Renaming does not
sweep: the ghost still exists, the units are the owner's files, and a timer
naming a ghost that moved fails visibly in `systemctl --user --failed`; the
daemon logs matching current-version units left under the old name rather than
deleting, rewriting, or guessing about legacy names. A timer-activated service
is a sibling of `ghostd.service`, never a child of it, which is what lets a
schedule survive a daemon restart that would kill anything in ghostd's own
cgroup. Timers fire only while the user manager runs and the daemon is up with
the owner's graphical session, so scheduled work makes no promise about
overnight or logged-out runs; #18 owns that.

A file a ghost authors *for the owner* — a report, an export, a generated image —
belongs in the owner's Documents tree or the requested working directory, never
in ghost-home persona, memory, or runtime files. Memory is private context for
one ghost; Documents are owner-wide files shared with the owner and every
ghost. Both runtimes carry this rule in their prompt.

Documents may be regular files of any type and may nest to any depth or width;
Ghost imposes no folder-depth or sibling-count policy on the live tree. It does
not parse arbitrary Markdown or text as a Ghost canonical format. Native
filesystem tools may read or mutate a path when a model or owner explicitly
chooses it. Automatic context is narrower: before each pi or Claude Code
turn, and for greeting input, Ghost lists only the root's immediate non-hidden
regular files and directories, folders first and then by name. It reads no file
content, follows no symbolic link, and never descends. At most 100 entries and
4,000 characters enter the prompt; the index states the exact number of
eligible root entries omitted. Names are fenced and treated as untrusted data.

Already-released Pi transcript headers are history: a legacy conversation resumes at the absolute cwd in its header rather
than silently changing the meaning of its relative tool paths. Project-state
inspection reads the runtime-qualified binding sidecar first and never opens the
Pi transcript when that sidecar exists. Only when the binding is absent may it
inspect a legacy header: it opens the mode-`0600`, single-link regular transcript
with `O_NOFOLLOW|O_NONBLOCK`, admits at most a stable 64 KiB prefix, decodes only
complete records as strict UTF-8 (reading one extra byte only as the overflow
sentinel), and accepts a session header on line one or on
line two after the title slot of an unconverted OMP-era transcript. The
append-only remainder may be
arbitrarily large and is not read. A missing, linked, special, incorrectly
permissioned, mutated, malformed, or overlong-prefix transcript supplies no cwd;
the project response truthfully remains the owner-home `default` rather than
granting legacy path authority.

Whenever the daemon parses a conversation control artifact — a project
binding, immutable Pi project snapshot, tool-cwd map, or draft/delete
transaction marker, including an upgrade-only legacy fork marker — it uses one
bounded descriptor-pinned reader. The final
entry is opened with `O_NOFOLLOW|O_NONBLOCK` and must remain a single-link
regular file with mode exactly `0600`; bytes are read positionally with a
declared cap and fatal UTF-8 decoding, and device, inode, size, timestamps,
mode, link count, descriptor state, and live pathname identity must agree
before and after the read. Only `ENOENT` from the initial open means absent.
A FIFO, link, oversized file, invalid byte sequence, or file removed, replaced,
or grown after admission is invalid state rather than an empty/default value.
Recovery markers remain the authoritative owner of their id on such an error;
the daemon neither erases them nor starts a replacement transaction.

Provider and MCP secrets are machine-wide Linux Secret Service items. Ghost
uses only items with `xdg:schema=io.github.ferdousbhai.ghost.Secret`, plus exact
`service` and `account` attributes; it never searches for, imports implicitly,
shares, or mirrors another pi installation's items. One item is one
`service/account` and its
versioned secret payload may hold several named fields. `models.json` and
`mcp.json` store only `keyring:<service>/<account>[#<field>]`. The no-fragment
field is `value`. `models.json.accounts` is the ordered, duplicate-free policy
list of bare `service/account` names this ghost may resolve. A reference outside
that list is forbidden even when the item exists.
`models.json` and every plaintext migration source — `mcp.json`, `.pi/auth.json`
— are read through `O_NOFOLLOW` from one single-link regular-file descriptor,
with a 1 MiB cap, fatal UTF-8 decoding, and unchanged descriptor and live-path
identity. Unsafe or changing input is invalid, never absent.

References resolve in memory only, immediately before provider or MCP
connection. pi's `ModelRuntime` receives Ghost's `GhostPiCredentialStore` (pi's
`CredentialStore` contract: read/list/modify/delete), which presents the first
allowed keyring account per provider; login and logout select the account. No
resolved value is projected to `.pi/models.pi.json`, a session sidecar, a log,
or HTTP. Keyring references, cross-process revisions, refresh leases,
revision-keyed caches, and literal-account/migration coordination are
secret-free and live in
`$XDG_STATE_HOME/ghost/keyring-metadata.sqlite` (default
`~/.local/state/ghost/keyring-metadata.sqlite`). The database is mode `0600` in
a `0700` directory. Secret values never enter it.

Opening any pi runtime probes `org.freedesktop.secrets` and the default
collection before migration or credential reads. A missing service, missing
default collection, locked collection, forbidden account, absent field,
malformed Ghost item, or failed read-after-write verification is a typed loud
error before session-open stream headers; there is no plaintext, environment,
pi-keyring, or keyless fallback around that failure. Secret Service protects
at rest and keeps secrets out of copied homes. It is not isolation from another
process already running as the same owner against the same unlocked service.

Migration is idempotent and serialized per home. It imports legacy plaintext
`.pi/auth.json` and, where an older home still has one, the OMP-era
`.pi/agent.db` credential rows, replaces provider `apiKey` and
header literals plus sensitive MCP environment/header/client-secret/URL and
recognized credential-argument values with references, read-verifies every
Secret Service write, atomically and durably replaces portable config, then
removes `auth.json` and empties and vacuums `agent.db` down to its schema and
change-counter rows. Every other table goes, not only the credential ones:
`usage_history` carries a provider email and account id per sample, `clients` a
hostname, `client_usage` per-model spend, and `cache` usage payloads keyed by
account, and none of it is read again. A credential the OMP-era runtime had
disabled is not
migrated and is deleted with the rest — Ghost's keyring store has no disabled
state to carry it into — so log in again to replace it. No source is removed or
replaced before its keyring writes verify; plaintext sources remain for retry. A
conflicting literal never overwrites a Ghost-known schema item, even if
secret-free metadata was lost: migration allocates `account-2`, `account-3`, and
so on. An `mcp.json` row the MCP catalogue itself rejects is not a migration
failure: migration skips it untouched, the catalogue keeps reporting it as
`invalid_mcp_server`/skipped, and any secret it holds stays plaintext in that
visibly invalid row until the owner corrects it, after which the next open
migrates it. Fail-closed is about the keyring, not about a neighbouring row's
shape. `.pi/agent.db` is read and scrubbed where an older home has one; no
session, login, or model listing creates one, so a home migrated or created
after this point carries no credential, identity, or usage residue there.
Credentials already copied into backup, sync, or Trash history remain exposed
there and may need provider-side rotation.

One naming convention makes the boundary readable rather than remembered. A
plain-named entry in a ghost home is part of that ghost's identity and travels
with it, including `settings.yml`, `models.json`, and `mcp.json`. A dot-prefixed
entry is bound to this machine and never leaves it: `.pi/` (derived pi
runtime), `.trash/` (recoverable per-home deletion state), and
`.memory-maintenance.json` (the consolidation cooldown), plus `.tasks/`
(machine-local native worker state). Export needs no
credential exception: portable files contain references rather than values.

### Session capabilities

Ghost is owner-local by default: the owner is the only local caller, and every
session uses the same ghost home, memory, owner-wide Documents tree, tools, and
route behavior. The tailnet viewer and session-scoped Remote voice route below
are deliberate off-machine capabilities and never broaden another ghost or
conversation. The collaboration route remains only as an unsupported legacy
compatibility seam.

A **principal harness** owns a Ghost conversation; today it is pi or Claude
Code. A **coding harness** owns one task delegated by that Ghost. The public
harness ids are `claude-code`, `codex`, and `pi`, and each means the owner's
installed native executable and configuration. An **agent** is an optional,
opaque native Claude Code agent name; Codex and Pi tasks always use their
default native agent. A **task worker** is the native
child process/session created for one task; it is an implementation detail, not
a selectable product or profile. Principal harness and coding harness are
independent choices; explicit native-agent selection is a Claude Code-only
capability. `character.md`, memory, Documents,
browser/desktop tools, and responsibility for the outcome belong to the Ghost
principal. A coding harness receives an ordinary task and trusted cwd, then
retains its own identity, configuration, agent discovery, models, tools,
plugins, skills, instructions, and internal delegation. Ghost owns no parallel
agent registry or agent model/tool policy. The read-only harness catalogue and
daemon task lifecycle below provide the principal's one durable delegation
boundary.

A pi session uses pi's runtime (`@earendil-works/pi-coding-agent`,
`pi-agent-core`, `pi-ai`) and native tools, but Ghost owns its roots and
provider-facing system prompt. A new conversation's operational cwd is the OS
account home (`os.homedir()`), while `agentDir`, `sessionDir`, character,
memory, persona, keyring policy, and MCP/config sources remain explicit paths
under the ghost home. Cwd is not storage and is not authority to
discover a project. Ghost renders the persona/system prompt itself and passes
it as the loader's `systemPrompt`; its persona extension then replaces that
prompt before every model turn (`before_agent_start`). No pi coding-agent
prompt prose is retained or subtracted by marker.

The Ghost-owned pi prompt is ordered: the complete `character.md` body (or a
two-line unwritten-character fallback); the fenced, bounded memory index; the
fenced, shallow Documents index; the shared Omarchy CLI-first computer-use,
owner-deliverable, Ghost self-documentation, coding-orchestration, and rendered
scheduled-work policies;
accepted instruction files and unconditional `alwaysApply` rules; a
compact index of visible skill names, descriptions, and `SKILL.md` locations; the
discoverable-rule index; then the seeded first-meeting section when applicable;
and finally a dynamic runtime section containing the current cwd and active
tool names plus only their registered one-line snippets. Ghost does not carry
pi's coding identity, generic guidelines, documentation pointers,
`APPEND_SYSTEM.md`, or a second native skill/context rendering across the
replacement boundary.
Skill bodies and conditional-rule bodies enter model context only when the
principal uses native `read`. The golden session fixture records the
complete provider-facing prompt and rejects known upstream prompt markers. A
provider adapter may add protocol-required blocks after this boundary; in
particular Anthropic OAuth adds its billing/fingerprint and Claude Agent SDK
identity blocks.

pi's native tools in a Ghost session are `bash`, `edit`, `find`, `grep`, `ls`,
`read`, and `write`. Ghost's own tools — `ghost_memory_write`, `ghost_browser`,
`ghost_desktop`, `ghost_screen`, `ghost_character`, `ask`, `task`, `task_list`,
`task_get`, `task_send`, `task_cancel`, and MCP tools named
`mcp__<server>_<tool>` — are registered directly as pi custom tools and appear
in `getActiveToolNames()`; there is no separate mount. The task tools reach
only the three coding-harness adapters. Through ordinary Bash, the principal
may run `ghost delegation` for the bounded native status described under
"Harness status"; it never reads, parses, or executes an agent definition. A
Claude principal exposes the same
logical task surface through its in-process Ghost MCP server and disables native
`Agent` and `Task`; a native Claude worker retains native subagent behavior. Live voice
(issue #44) is deferred; goals with budgets belong with
always-on check-ins (issue #18).
Ghost's `settings.yml`,
`models.json`, and `mcp.json` are read from the ghost home, never the live cwd.
pi's `DefaultResourceLoader` runs with `noExtensions`, `noPromptTemplates`,
`noThemes`, and `noContextFiles`. Native skill loading is enabled only for the
machine paths above, while `projectTrusted` is false so pi cannot independently
rescan the operational cwd. Ghost supplies the remaining declarative categories
itself from the visible ghost home plus one trusted project snapshot. Ghost
imports only its descriptor-pinned visible
`hooks/pre` and `hooks/post` entries as already-admitted Ghost extension
factories, adapted to pi by `packages/daemon/src/pi-extension-bridge.ts`;
neither the ghost home's `tools/` nor any owner-home or bound-project root is
offered to pi. Project extensions, hooks, TypeScript
commands, custom code tools, and LSP are disabled for phase 1. Project and
ghost-file agent definitions are excluded from the spawn allow-list until #31
supplies an isolated custom-agent seam. MCP comes only from Ghost's own
`GhostMcpManager` (over `@modelcontextprotocol/sdk`): a session receives only
the ghost's `mcp.json` plus the explicitly bound project's native
`.omp/mcp.json`/`.omp/.mcp.json` files. It never scans pi's user/global config
or another coding agent's MCP config merely because cwd is the owner home.
Failures are `mcp_connection_failed`, `mcp_tool_load_failed`, or
`mcp_tool_call_failed`, and a live tool-list change reloads the session. A
failed project MCP
load marks that conversation's project state `degraded`; it does not fall back
to ambient configuration. Project MCP bytes share the declarative scan's
descriptor confinement and 256 KiB per-file/1 MiB aggregate caps; that one scan
produces the exact parsed and validated rows consumed by Pi and Claude, so
neither runtime reopens a project MCP pathname between admission and launch.
The two fixed project MCP candidates are checked before broad declarative
directory walks consume the shared entry, byte, or cooperative-time budget. If
the scan cannot admit or determine one, it records an MCP-specific rejection
instead of silently treating that candidate as absent.
The visible ghost `mcp.json` remains a distinct mutable owner source and is the
only MCP input refreshed by a ghost-level MCP mutation. Before any cast,
redaction, persistence, expansion,
or launch, Ghost applies its own strict transport-discriminated schema: command,
URL, cwd, arguments, records, flags, finite timeout, request-id, auth, and OAuth
fields must have exactly their declared types, and unsupported fields are
rejected. A malformed row is skipped with a generic field-only reason, cannot
hide valid siblings, and no supplied value crosses HTTP or logging. That one
schema is also what the keyring migration recognizes, so a row is never valid
to read and invalid to migrate, or the reverse.
Accepted server names remain opaque own map keys through configuration,
provenance, connection status, runtime translation, and durable metadata; a
name matching a JavaScript Object prototype member is never inherited,
dropped, or allowed to mutate dictionary state.
Source provenance remains exact after injection: rows from the visible
ghost `mcp.json` carry user-level source metadata, while rows from the trusted
bound project carry project-level metadata. The isolated ghost MCP connection
probe likewise marks its visible source user-level.

For pi stdio MCP, an omitted `cwd` becomes the immutable source root that owned
the row (ghost home or trusted project); a relative `cwd` resolves against that
same root after Ghost's `${VAR}` environment expansion, never against ghostd's
owner-home process cwd. An explicit absolute cwd remains explicit. Claude project MCP
inherits the query's persisted operational cwd when `cwd` is omitted. The
Claude SDK phase-1 translation has no cwd field, so an explicit stdio `cwd` row
is rejected from the snapshot with a warning and publishes degraded project MCP
status rather than silently running it elsewhere. `ghost_browser` owns the
browser surface. For laptop, shell, and Omarchy-system actions, both runtimes
first discover a stable route with `omarchy commands --json` or group help and
invoke `omarchy <group> <action>` through Bash. `ghost_desktop` and
`ghost_screen` are the fallback when Omarchy has no route, a tried CLI route
fails, or the task must manipulate arbitrary application content. Ghost memory
is plain files in the ghost home (see the harness invariants).
`vision_model` stays unset until bound; an image-inspection tool for pi
sessions is a planned port (issue #3).

Documents and memory retrieval use those native filesystem tools directly.
Ghost registers no duplicate document list/read/search/write tools, and
keeps only `ghost_memory_write` for validated, atomic memory-file writes. The
writer accepts only the fact content and an optional slug; the memory index and
root-only Documents index are derived from disk before each model turn and are
never stored. A foreground session rewrites a changed fact through that writer;
it has no deletion tool. Idle consolidation alone retires obsolete memory.
Skill invocation remains model-driven through native `read`; Ghost does not
add a principal-only command syntax around it.

`GhostHome` exposes no live legacy document list, read, find, write, or search
API; live Documents are exclusively the machine-wide `MachineDocuments`
boundary.

Ghost has no principal plan mode, plan approval state, or model-owned todo
list. Planning is ordinary owner conversation or a read-only assignment to a
native coding harness; implementation begins only when the owner asks for it.
Durable coding work is represented by harness tasks rather than a second
principal workflow. Historical `ghost-plan` and `ghost-todo` custom transcript
entries and files under a legacy `plans/` directory remain owner data but are
inert: Ghost neither renders, mutates, nor deletes them implicitly.

`inspect_image` is Ghost-owned (`packages/daemon/src/inspect-image.ts`) and
exists for a chat model that cannot see images: it reads one
png/jpg/gif/webp file (relative paths resolve against the conversation cwd),
resizes it with pi's own image resizer, and asks the ghost's
`roles.vision_model` (read from `models.json` at call time; the bound model
must accept images) to describe it, with the optional `question`, returning
the description through the shared untrusted-text result (fenced, injection-
flagged). A blind chat model with no vision model bound is a tool error
naming the role to bind. A chat model that accepts images is told to use
pi's `read`, which attaches image files itself; `ghost_screen` already points
a blind model at `inspect_image` for its saved frames.

Ghost registers neither `web_search` nor `web_fetch` for pi and packages no
third-party CLI or skill. Omarchy itself owns its packaged skills, standard-root
links, and CLI command catalog; Ghost admits those links like every other
machine skill. The owner installs and updates other optional integrations from
their upstream source as the desktop user:

- Firecrawl: `npx -y firecrawl-cli@latest init --all --skip-auth` (replace
  `--skip-auth` with `--browser` for its authenticated flow).
- HEY: current Omarchy supplies a mise-backed `hey`; an older install with no
  `hey` command runs `omarchy update` to receive that migration, then
  `hey skill install`.
- Basecamp: `omarchy pkg add basecamp-cli`, then `basecamp skill install`.
- Obsidian: `omarchy pkg add obsidian`, enable **Settings → General → Command
  line interface** in Obsidian 1.12.7 or newer, then install the desired skills
  from `https://github.com/kepano/obsidian-skills` with `npx skills` globally.
- Google Workspace: `npm install -g @googleworkspace/cli`, then install the
  desired service skills from `https://github.com/googleworkspace/cli` with
  `npx skills` globally.

Firecrawl's main skill routes web work through its CLI over `bash` and links
its other installed skills progressively. Other admitted machine skills
similarly teach the runtimes to invoke their CLIs through `bash`; Ghost adds no
product-specific tool. Claude Code receives the same immutable machine-skill
index in its prompt but does not enable the SDK's unscoped ambient skill
discovery.

Background jobs are Ghost-owned (`packages/daemon/src/jobs.ts`) and
conversation-scoped. Ghost's own `bash` tool replaces pi's by name and runs
every command as a job of the session over pi's local shell operations:
`background: true` answers with the job id at once, and a foreground command
waits up to the daemon's auto-background budget (`jobs.autoBackgroundMs`,
default 60 s, `0` disables; never past the call's own `timeout`) and then
keeps running as a job while the model gets the output so far and the id. A
foreground command that settles in time answers like pi's tool: its output, or
an error carrying the output plus `Command exited with code N` /
`Command aborted`. The `jobs` tool lists, waits for (default 30 s, at most
300 s), or cancels jobs. Every job belongs
to the session that started it: it survives the turn but not the session
(`close`, retention eviction — which a running job prevents — and daemon
shutdown cancel it), it keeps a bounded output tail (the newest 64,000 bytes
of whole chunks) in memory only, and the newest 50 settled jobs stay listed.
When a job settles, its report enters the conversation as an agent-attributed
`ghost-job-result` custom message (`details.jobId/status/exitCode`) delivered
through pi's own queue: behind the live turn when one is streaming, otherwise
as a follow-up turn of its own; a session an owner holds without streaming
receives it at the release boundary. A job cancelled before delivery still
reports (`was cancelled`); jobs cancelled by session teardown do not.

Ghost has no principal slash-command catalog, command browser, completion menu,
command-output transcript row, or direct shell sigil. Leading `/`, `!`, and
`!!` have no privileged meaning at the principal boundary: they are ordinary
owner text under both pi and Claude Code. Ghost operations live in the HUD,
daemon API, CLI, or registered tools, and the ghost itself uses its `bash` tool
for computer work. Pi is constructed with prompt-template and skill-command
expansion disabled, so it cannot reinterpret slash text after admission.
Legacy `bashExecution` entries in existing Pi transcripts remain readable
as assistant text; Ghost creates no new entries of that role.

Long-context maintenance is pi's native compaction. The daemon projects its
owner-facing `compaction.enabled`, `thresholdTokens`, and `thresholdFraction`
settings onto pi's `reserveTokens` for the bound model's context window: a
fixed token threshold takes precedence; otherwise the default is 80% of the
active model's window. This deliberately replaces the former
`min(80% of window, 100k)` threshold with a model-relative policy that
continues to fit when the model changes; Ghost does not re-create the cap, so
on a very large context window a conversation runs further before it compacts.
Ghost contributes only the summary instructions (`GHOST_COMPACTION_PROMPT`)
through `session_before_compact`; pi owns the rest of compaction.

Conversation-idle memory maintenance is a separate Ghost lifecycle, shared by
Pi and Claude Code rather than inferred from either harness's notification
events. Every owner action first reserves its runtime-qualified conversation,
cancels and drains any background generation, and only then reaches the model.
After a completed or failed owner turn is durably settled, the daemon records
its immutable owner prompt, bounded assistant text, runtime-native source
revision, and a daemon-generated monotonic sequence. Each `conversation_idle`
registration has its own whole-second `idleSeconds` deadline; the scheduler
wakes at the earliest deadline, dispatches only registrations then due, and
reports actual elapsed idle time. Ghost's memory registration is due after 60
seconds. Every registration has a stable semantic identity across an unchanged
hook configuration. Restart derives the remaining (or overdue) delay only for
registrations not durably delivered for the current activity generation, from
durable `lastActivityAt`, never a fresh 60-second window. At most one generation
runs per conversation and one newest pending trigger is coalesced; a new owner
action, conversation delete, whole-home move, or shutdown aborts and drains it.
If a transient/aborted/model failure leaves pending turns without an active
receipt, exactly one fixed 60-second retry is armed; repeated failures re-arm
that bounded delay rather than hot-looping. Its exact kind, stable registration
identity, and ISO `dueAt` are persisted before maintenance dispatch and after a
failed attempt, so restart preserves the remaining/overdue delay. A retry
targets the built-in memory registration by its exact registration identity;
another `conversation_idle` handler or machine command with the same numeric
deadline is ordinary due work and is not dispatched again by that retry. Whole-home
work takes the shared home lease before resolving a home path and keeps that
lease through model use, memory access, and state publication.

Conversation deletion reserves maintenance before publishing its tombstone.
Its release outcome is explicit: `rolled-back` re-arms pending work only while
no tombstone owns the id (or after that tombstone was durably retired),
`recovery-pending` releases the active drain but keeps the runtime-qualified
slot suppressed for a same-process retry, and `completed` is accepted only
after successful deletion removed the slot. Startup restoration applies the
same suppression when a tombstone remains; an owner action cannot re-arm the
conversation between resumable DELETE attempts.

Machine-level command-hook configuration admits only non-empty, NUL-free
commands. Every command dispatch owns its process tree and catches synchronous
spawn failure, process-start error, and unexpected execution rejection at the
awaited hook boundary. Those failures are generically logged and fail open for
`before_prompt`, `session_stop`, and `conversation_idle`; they cannot fail an
owner turn or expose the command/error payload.

The ordinary maintenance model receives only a close-neutralized untrusted
transcript fence and four memory-only tools: list metadata, read one memory,
plain-text search, and one atomic write. It has no Documents, character,
deletion, network/MCP, native filesystem, shell, or general session tool. One
ordinary generation may publish at most one memory file. Memories must be
grounded in what the owner said or confirmed; assistant text alone may carry
external or untrusted content and is not evidence worth memorizing.

Pressure makes that idle delivery run consolidation instead of ordinary
maintenance. Pressure means the derived index occupies at least 3,200 of its
4,000 characters, the budget omits any memory, or the home has at least 100
valid memory files. A mode-`0600` v1 `.memory-maintenance.json` records the ISO
time at which consolidation is claimed; another consolidation may be claimed
only after six hours. Claim publication precedes the generation, so concurrent
conversations cannot both consolidate one ghost and a failed attempt also gets
the cooldown rather than creating a provider-failure loop.

Consolidation receives the same four tools plus `delete_memory`. It may publish
at most four writes and four recoverable deletes, in journaled sequence, and
may touch one memory path only once. Its doctrine merges duplicate or
overlapping facts under the clearest slug, deletes only a no-longer-true memory
or one fully superseded by a write in that run, minimizes churn, and prefers a
no-op. Transcript and memory-file contents are data, never instructions. A
completed consolidation emits one foreground receipt notice listing every
mutation, or that it made none.

Before each memory rename, the GhostHome writer invokes the daemon's receipt
journal callback inside the existing memory queue and descriptor lock. A write
intent carries exact `before`/`after` bytes and their SHA-256 digests; a delete
intent carries exact `before` bytes and digest plus the reserved trash name. A
mode-`0600` v1 sidecar beside the transcript carries an immutable UUID
incarnation, exact runtime/raw conversation identity and source identity,
monotonic state/turn/activity revisions, bounded pending turns, completed
notices, the bounded unique registration identities already delivered for the
current activity generation, the optional exact built-in memory retry, and the
active generation, mutation, and ordered receipts. The original v1 run shape
without a mode remains valid as an ordinary run; the exhaustive validator
admits at most one write receipt there, or the consolidation limits above.
It is read through the common bounded daemon control-file reader; only
initial `ENOENT` is empty. It is written by a same-directory `wx` temporary
file, file fsync, atomic rename, and directory fsync. The source is exactly
`{ runtime:"pi", createdAt }` for Pi and
`{ runtime:"claude-code", createdAt, resumeId }` for Claude; its discriminator
must match the outer runtime, and Claude's persisted SDK resume id is required.
The source revision discriminator is equally strict: Pi state and incoming
settlements admit only `pi-leaf`, while Claude admits only
`claude-owner-turn`. A mismatch is invalid state/input and cannot overwrite the
sidecar.

Every parsed intent and receipt recomputes its SHA-256 digests. Write recovery
also re-reads exact current memory bytes for an already stored completed
receipt: bytes equal to `after` complete it. Bytes equal to `before` are
verified against both stored digests and the exact journaled `after` bytes are
replayed under the same descriptor lock, without another model generation;
receipt publication and intent clearing are one atomic sidecar replacement.
Any third write value is a conflict that writes nothing and retains the pending
work.

Delete recovery never re-deletes. Only an absent source together with the
exact journaled bytes at the exact trash name completes a delete intent or
receipt. Every other combination, including an unchanged source with no trash,
a restored source, missing trash, different bytes, or an unreadable entry, is
ambiguous: recovery leaves every surviving file in place, settles that run, and
publishes a foreground notice naming both observed states. Completed mutation
notices remain until the runtime acknowledges durable prompt attachment.

Idle delivery uses two deliberate crash semantics. A non-maintenance observer
or command is claimed in the sidecar before invocation and is therefore
at-most-once for that activity generation: restart never duplicates a
side-effecting hook, but a process crash after the claim and before execution
may skip it. The receipt-journaled built-in memory registration instead stores
its exact retry before invocation and is at-least-once until its pending turns
settle; exact memory intent/receipt reconciliation makes a repeated attempt
safe. A new model turn atomically increments the activity generation and clears
prior delivery/retry progress.

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

**Tailnet identity** (`packages/daemon/src/tailscale-identity.ts`) is the one
alternative to the bearer token. Ghost owns a Tailscale Serve proxy to the
loopback daemon, and Tailscale stamps `Tailscale-User-Login`,
`Tailscale-User-Name`, and `Tailscale-User-Profile-Pic` on each request —
stripping any such header a client sent itself. Ghost accepts that identity
exactly as Tailscale documents it: only on a loopback connection (a local
process that could forge the header could already read the token file — the
same trust domain), and only through the `RemoteAccess` the daemon is started
with (`main.ts` builds it from the `remote` config; a server without one
admits no identity). The login equal to `remote.owner` (default: the login
this node is signed in as, from `tailscale status`, asked again until it
answers) is the **owner** and may do everything the token may; any other
member is a **guest**: `GET` only, else `403 read_only`, and nothing at all
when `remote.guests` is `"none"` (`"read-only"` by default). One origin rule
covers both callers: an `Origin`, when present, must be loopback or name the
host the request was addressed to (the tailnet name the viewer was served
from), else `403 forbidden_origin`, checked before any credential. `GET
/api/remote/whoami` reports `{ login, role, name? }` for an identity caller
and `{ login: null, role: "owner" }` for the token.

**Remote access** is configured by `remote.enabled` (default `false`) and
owned by `packages/daemon/src/remote-serve.ts`. `GET /api/remote` reports the
Tailscale and Serve state, read from Tailscale on every call; an owner-only
`POST /api/remote { enabled }` changes it and durably updates the config file.
`GET /api/remote/qr.svg` returns a no-store QR code for the active URL, while
the unauthenticated `GET /manifest.webmanifest` makes the viewer installable.
When the tailnet advertises certificate domains Ghost serves HTTPS on port
443; otherwise it serves HTTP on port 80. A configured exposure is
idempotently re-applied after ghostd starts listening, moving from HTTP to
HTTPS once certificates become available. Status problems are
`tailscale_missing` (`omarchy-install-service-tailscale`), `tailscale_stopped`,
`not_logged_in` (`tailscale up`), `operator_required`
(`sudo tailscale set --operator=$USER`), or `serve_failed`; codes without a
parenthesized command have no automatic action to offer. A failed change is
the problem of the response that reports it; only an operator refusal is
remembered (`tailscale.operator: false`, and the problem on later status
reads) until Tailscale accepts a Serve change, because only a write reveals
it.

The daemon serves a built-in viewer page at `GET /`
(`packages/daemon/src/remote-viewer.ts`: one HTML file, no framework; its CSP
allows only the page's own inline script and style by hash and `connect-src
'self'`, plus its own manifest) that a phone or another laptop opens over the
tailnet: ghost and
conversation pickers, the transcript, live refresh over `GET …/events`, and —
for the owner only — a composer that posts to `…/messages` and renders the
stream. It carries no token; the identity comes from `tailscale serve`, so on
plain loopback the page reports unauthorized. Off the tailnet it needs Funnel
plus the bearer token and is not the intended path.

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

### `ghost` CLI

`ghost` is a consumer of this HTTP contract except for `ghost delegation`, the
daemon-independent, read-only native harness/Omarchy query described under
"Harness status". It does not open sessions or read a ghost home. Ghost
selection resolves in this order: `--ghost`, `$GHOST`,
the private mode-`0600`
`$XDG_CONFIG_HOME/ghost/cli.json` (default `~/.config/ghost/cli.json`) field
`{ "ghost": "<name>" }`, then the sole ghost when exactly one exists. Session
selection is `--session` by exact id or unique public/raw-id prefix, then the
most recently updated conversation. The stable process exit codes are:

| code | meaning |
|---:|---|
| 0 | success |
| 1 | turn or action failed |
| 2 | usage error |
| 3 | daemon unreachable |
| 4 | unauthorized |
| 5 | not found |
| 6 | busy or conflict |

With `--json`, API-backed non-streaming commands preserve the exact response
shape, `ghost delegation` returns its bounded local projection plus cwd, and
streams emit one complete event object per line.

### Routes

- `GET /api/hooks` → `{ active, total, events, hooks,
  sessionStopContinuationCap }` — authenticated, redacted hook diagnostics.
  `events` is the nonzero canonical-order list of `{ event, count }`; `hooks`
  has one canonical-order `{ event, source, name, description }` row per
  registration, where `event` is exactly `before_prompt`, `session_stop`, or
  `conversation_idle`, `source` is `builtin` (registered in-process) or
  `config` (a `hooks.json` command), with integer `idleSeconds` only on
  `conversation_idle` and `settingsKey` only on a `builtin` row that
  `hooks.json`'s `builtin.<key>` section tunes. `active` is
  `total > 0`, and `total` equals both event counts and row count. The body
  never exposes commands, source paths, arguments, prompts, injected context,
  errors, receipts, or scheduler state; the owner's commands live on the
  config route below.
- `GET /api/hooks/config` → `{ path, document }` — the admitted `hooks.json`
  as one object (`{}` when the file does not exist) and its absolute path.
  404 on a daemon built without a hooks file.
- `PUT /api/hooks/config` with the whole document → `{ path, document }`.
  The daemon's loader is the only validator: a rejected document is a 400
  whose message names the offending field, the file and the live hooks are
  untouched. An admitted document is written through a temporary file and
  one rename, then the running command hooks are swapped without a restart:
  `before_prompt` and `session_stop` changes apply at the next boundary; a
  changed `conversation_idle` registration arms from the next owner activity
  and a deadline already armed against a retired registration settles as a
  no-op. Built-in hooks are registered in code, not in the document; the
  document's optional `builtin.<key>` object (`{ idleSeconds }`, integer
  `1..86400`) tunes the built-in hook whose status row carries that
  `settingsKey`, is validated by the same loader, and applies at the next
  daemon start — never live, because a built-in idle registration's identity
  includes its interval and persisted retry state refers to that identity.
  Today `memory_upkeep` is the one such key. The document is replaced whole,
  never patched per hook, because group and handler order is file order. An
  edit made to the file outside this route still needs a daemon restart. `sessionStopContinuationCap` is an
  integer in `1..100`, the daemon's consecutive hidden-continuation cap
  (`GHOST_SESSION_STOP_CONTINUATION_CAP`, default 10); clients display it and
  never assume its value.
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
  schedule; emptying the trash is the owner's. Delete never reads or removes a
  machine keyring item, so restoring the home restores its references and
  policy without losing the service/account login. Checked in this order:
  `confirm` must be present and byte-equal to `:name`
  (`400 confirmation_required`); an unknown ghost is `404 not_found`; a ghost
  with any conversation busy, opening, or mid-delete — pi or Claude Code — is
  `409 ghost_busy`, as is a second concurrent delete of the same ghost. Idle
  hosted sessions are closed (disposed, not deleted) and pending
  title work is awaited first. **Deletion is a move, never an `rm`**:
  the ghost home holds the only copy of a persona and its memory, so
  nothing on any path follows the rename with a recursive removal.
- `PUT  /api/ghosts/:name/name` `{ name: "<new>" }` → `{ ok: true, name }` — the
  ghost's name IS its home directory's name, so renaming one is anchored by a
  same-filesystem rename of `<root>/<old>/` to `<root>/<new>/`. Persona, memory,
  conversations, pins, keyring references, and account policy are inside the
  directory that moved; machine credentials are service/account scoped and the
  rename never reads or writes Secret Service. Every conversation id stored with
  its transcript stays valid, and every other route's `:name` changes with it.
  `character.md` is the ghost's own words and is never touched. The one
  exception is a character file byte-equal to the daemon-authored seed: it is
  re-rendered in canonical Markdown under the new name. That replacement is
  staged beside the character file before the home moves and published
  atomically afterwards; a staging failure moves nothing, and a publish failure
  rolls the home move back. Checked in this order: the new name gets the same
  validation `POST /api/ghosts` applies (`400`); an unknown ghost is
  `404 not_found`; renaming to the ghost's current name is a no-op `200`; a name
  already taken in the root — by a ghost or by anything else — is
  `409 already_exists`; a ghost with any conversation busy, opening, or
  mid-delete is `409 ghost_busy`, the same gate `DELETE` uses, as is a second
  concurrent rename or delete. Idle hosted sessions are closed and pending title
  work awaited first, so nothing holds a path under the old name across the
  rename. A Claude Code conversation keeps its resume sidecar, but that runtime
  stores the transcript itself under its own `~/.claude/projects/<cwd>` path,
  which does not move with the home.
- `GET  /api/ghosts/:name/memory` → `{ memory, skipped }` — the owner's
  memory list, read from the plain files on each request and never stored.
  `memory` holds `{ path: "memory/<slug>.md", slug, content, updated }` in the
  index's order (newest first, slug as the tie-break), where `content` is the
  whole file (the fact) and `updated` is the full ISO filesystem modification
  timestamp. `skipped` reports malformed memory files
  as `{ path, reason }` without hiding the valid siblings. Paths are
  ghost-home-relative; a client already gets that home's absolute `dir` from
  `GET /api/ghosts`. The shell shows this list as it is: one editable row per
  fact, no derived title or preview, and it watches the directory instead of
  offering a refresh.
- `PUT  /api/ghosts/:name/memory` `{ content, name? }` →
  `{ ok: true, slug, path, created }` — creates or replaces exactly one memory
  file through the same validating, redacting, atomic `GhostHome` writer as
  `ghost_memory_write`; an omitted `name` derives the slug from the fact. A
  format rejection (empty, over the limit, bad slug) is a 400 with the writer's
  own message.
- `DELETE /api/ghosts/:name/memory` `{ path, confirm: path }` →
  `{ ok: true, path, trash, kind }` — moves exactly one Markdown file under
  `memory/` to recoverable Trash. `confirm` must byte-match `path`; absolute
  paths, traversal, non-Markdown paths, directories, and anything outside
  `memory/` are refused. A symlink is moved as a symlink and never followed.
  The ordinary destination is the freedesktop home Trash; cross-filesystem
  moves fall back to `<ghost>/.trash/`, still by rename rather than copy/unlink.
- `GET  /api/ghosts/:name/mcp` → `{ servers, skipped }` — the effective
  ghost-only MCP configuration from `<ghost>/mcp.json`. It never
  scans ambient pi, Codex, Claude, Copilot, or other agent configuration. Each
  valid server is `{ name, enabled, source, path, config, connectionStatus }`.
  `config` is deliberately lossy: header/environment key names and counts may
  be shown, but their values, command arguments, OAuth/auth credentials, URL
  userinfo, and query values never cross HTTP. Non-secret placement/policy
  fields (`cwd`, `envPolicy`, and `headerPolicy`) do cross so replacement edits
  preserve the server's execution semantics. A displayed URL preserves only a
  parsed hierarchical HTTP(S) origin/path; userinfo and fragments are removed
  and query values become `[configured]` markers. Malformed, templated, opaque,
  and non-HTTP(S) strings are wholly `[configured]`.
  Before a live connection or isolated test, Ghost applies its own `${VAR}`
  environment interpolation to the rest of the validated server row. Before
  that expansion it resolves allowed `keyring:` references into a fresh
  in-memory row. Environment values, header values, OAuth/auth client secrets,
  sensitive URL values, and recognized credential arguments written through the
  management API are read-verified into Secret Service and the writer receives
  their references; a supplied reference is accepted only when its bare
  service/account is in `models.json.accounts`. A stdio
  `env` map with `envPolicy:"literal"` and a remote `headers` map with
  `headerPolicy:"origin-locked"` are excluded from that traversal and reach
  `GhostMcpManager` value-for-value; ambient environment values never enter
  those protected maps. Rows without the policy retain the ordinary expansion
  behavior. `connectionStatus` is
  `connected`, `connecting`, `disconnected`, `mixed`, `disabled`, or
  `not_loaded`; GET only inspects already-open pi conversations and never
  opens one. Malformed files/rows appear in `skipped` without hiding valid
  siblings.
- MCP mutations use Ghost's locked atomic `mcp.json` writer and return the
  refreshed sanitized snapshot: `POST /api/ghosts/:name/mcp`
  `{ name, config }` adds to `mcp.json`; `PUT|DELETE
  /api/ghosts/:name/mcp/:server` replaces/removes the named entry;
  `PUT …/:server/enabled` `{ enabled }` toggles it. Every mutation reloads all
  open pi conversations for the ghost before the response snapshot's
  `connectionStatus` is inspected, so that field describes the manager and
  mounted tools that completed this mutation rather than their prior state. An
  idle session reconnects and replaces
  its mounted MCP tools immediately, connecting a candidate manager before it
  swaps away the live one. A pre-stream ordinary turn admission and the
  ghost-wide MCP mutation/reconnect lease are mutually exclusive in both
  admission orders: the loser receives `409 session_busy` before a config write,
  manager transition, or SSE header and retries after the winner settles. A
  raw voice owner that began outside this HTTP admission coalesces an
  already-admitted change into one reload after it settles. Writable
  collaboration is admitted at CollabHost's raw `promptCustomMessage` boundary.
  Candidate connection may run concurrently, but manager/tool publication and
  old-manager disconnect take a per-session publication lease: a raw prompt
  that wins first holds the existing manager and tools unchanged until its
  terminal session event, while publication that wins first completes before
  the raw prompt reaches the AgentSession. Prompt failure, abort, and shutdown
  release this ownership in `finally`, so a deferred publication can retry and
  no collaboration stream observes a mid-turn refresh or disconnect.
  If live tool publication fails after the atomic config write, the mutation
  request fails, the durable new config remains available for retry, and the
  candidate swap restores the previous manager and mounted tools.
  A bound project's failed rows/connections leave its
  state explicitly `degraded`. Thus adding the first server mounts tools, and
  updating, disabling, or removing one cannot leave stale tools selected.
  Model and MCP mutations take a filesystem-identity operation lease before
  resolving any home path. Whole-home rename/delete first block new leases and
  drain admitted mutations before sessions are quiesced and the directory
  moves, so an awaited runtime or config writer cannot recreate the old name.
- `POST …/mcp/:server/test` runs an isolated no-session connection probe and
  returns a sanitized `result` with status/tool count; transport error text is
  not returned because it may echo secrets. `POST …/mcp/:server/reconnect`
  manually retries already-loaded live managers without opening a conversation.
  Each idle session connects a complete candidate from its manager's existing
  immutable configs/sources, then publishes that manager through the same
  prompt boundary and only then disconnects the prior transports. It reports
  `not_loaded` when none exists and `deferred` for an already-owning raw
  collaboration/voice session. An ordinary admitted turn is instead the
  `409 session_busy` lease conflict described above. When the requested server
  has project-level provenance, Ghost derives configured and failed project
  counts from the complete candidate result plus the immutable snapshot's
  rejected rows, then compare-and-swaps runtime health against the binding's
  root identity and generation. A fully successful retry changes
  `degraded` to `ready`; a failed project connection changes `ready` to
  `degraded`, and either successful publication emits
  `conversation-updated` with `reason:"project"`. A stale-generation result is
  discarded without an event. Reconnecting a user-level ghost `mcp.json`
  server never rewrites bound-project health.
- `POST /api/ghosts/:name/messages` — the **pi-messages wire protocol** over
  pi's `AgentSession` (request `{ model, context, options }` → SSE stream).
  The pinned client in the summon-ghost repo is the normative spec
  (`~/github.com/ferdousbhai/summon-ghost`, read-only reference).
  Every native `tool_execution_start` includes `cwd`, the absolute
  `SessionManager.getCwd()` snapshot captured at execution start. It is
  activity-local: a client must not substitute a later session cwd for it.
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
  "Conversation titles" below). pi transcripts and Claude Code resume sidecars
  share this shape (a Claude conversation's `title` is `"Claude Code"`).
- `GET /api/ghosts/:name/sessions/:id/project` →
  `{ id, conversationId, runtime, root, cwd, relativeCwd, name, generation,
  status, error, mcpStatus, resources, canRebind, lastRefreshAt, reason }`.
  This route, preview, and PUT accept a valid runtime-qualified id before its
  first turn; a project sidecar alone does not publish a row in `GET …/sessions`.
  `root` is the canonical trusted project root or `null`; `cwd` is always the
  absolute operational cwd; `relativeCwd` is `"."` at the root, a relative path
  beneath it, or `null` while unbound. `status` is `unbound`, `ready`, or
  `degraded`; `error` is null or `{ code, message }`; `mcpStatus` is `off`,
  `ready`, or `degraded`. `resources` always contains non-negative
  `instructions`, `skills`, `rules`, `prompts`, `commands`, `agents`,
  `mcpServers`, and `ignoredExecutable` counts. Instructions and the typed
  declarative categories count only entries that the bounded parser accepted;
  in particular, a skill requires explicit nonempty string `name` and
  `description` fields in its own frontmatter. A malformed/missing field is
  warning-skipped; Ghost never synthesizes a name from the directory, so it
  cannot shadow an accepted ghost or project sibling. `agents` and
  `ignoredExecutable` are discovery counts because those
  categories are deliberately inactive. The counts are a bounded, content-free
  preview, not an authorization to execute anything. One scan
  admits at most 512 entries, 1 MiB total file data, 256 KiB per file, and eight
  path components measured from the project root. A one-second cooperative scan budget is checked before and
  after each admission and between directory reads; an already-issued kernel
  I/O operation is not cancellable, so it may return after that wall-clock
  point, but its result is not admitted. It reports every reached cap and
  ignored symlink or rejected typed resource in `warnings`; counts describe
  only admitted, effective entries. Every declarative and MCP candidate is
  decoded as strict fatal UTF-8 before parsing. Invalid instruction, skill,
  rule, prompt, or command bytes are warning-skipped without admitting a
  replacement character; invalid MCP bytes produce an MCP-specific rejection,
  so runtime health cannot report that source as merely absent. Preview
  performs the same bounded typed validation needed to make those counts
  truthful, but returns no resource content and does not authorize or persist
  its scan. Bind/reload performs one new content-bearing scan and retains its
  exact validated project MCP rows in the immutable runtime snapshot; those
  values do not cross this HTTP response.
  The durable binding sidecar is an exact-key version-1 object containing only
  `version`, `runtime`, `conversationId`, `root`, `cwd`, `generation`,
  `status`, `error`, `mcpStatus`, `resources`, `lastRefreshAt`, `reason`, and
  `identity`. Root and cwd are canonical absolute non-NUL paths bounded to 16
  KiB of UTF-8; a bound cwd is confined beneath root. A bound root has an exact
  `{ dev, ino }` identity whose canonical decimal members are at most 64 digits.
  The persisted root/identity pair must exactly match an existing trusted-ledger
  row; a mismatch is corrupt binding metadata. The separately pinned live root
  must still match that trusted identity, and replacement of an otherwise-valid
  project's inode retains the ordinary `project_not_trusted` response. A null
  root requires null identity, unbound/off/null health, and zero resource counts.
  Generation and every exact resource field are non-negative safe integers;
  statuses, MCP state, and reason are closed enums; `lastRefreshAt` is null or
  an exact ISO timestamp. `error` is null or an exact nonempty string pair
  `{ code, message }`, bounded to 128 and 8,192 UTF-8 bytes respectively.
  Preview warnings are not binding state and are never persisted; an added
  `warnings` member is therefore invalid rather than a compatibility bag.
  Missing, extra, mistyped, noncanonical, inconsistent, or out-of-bound fields
  fail `500 project_binding_invalid` without default repair, legacy transcript
  fallback, trust bypass, or rewriting the bytes.
- `POST …/sessions/:id/project/preview` `{ path }` requires an absolute
  directory and returns `{ root, name, trustToken, expiresAt, resources,
  warnings }`. `warnings` is an array of strings. The opaque short-lived token
  is bound server-side to ghost, runtime-qualified conversation id, canonical
  path, device, and inode; equal raw ids in different ghosts cannot exchange a
  receipt, and device/inode never cross HTTP. Conversation deletion or raw-id
  reuse and whole-ghost rename/delete revoke every outstanding receipt for the
  old incarnation. Preview uses the same transition/tombstone gate as bind and
  reload, so none can mint a receipt while those lifecycle operations own the
  identity. Confirmed trust is stored
  machine-locally in `$XDG_STATE_HOME/ghost/project-trust.json` (default
  `~/.local/state/ghost/project-trust.json`), mode `0600`, and becomes invalid
  when the path resolves to a different filesystem identity. Only `ENOENT`
  means an empty trust ledger. An existing ledger is read through componentwise
  non-following directory descriptors and a pinned regular-file descriptor,
  capped at 1 MiB, decoded as fatal UTF-8, and required to have one link, mode
  exactly `0600`, the exact version/row schema, and unchanged device, inode,
  size, mtime, ctime, and live directory-entry identity across the read.
  Malformed, wrong-version, linked, wrong-mode, oversized, permission-denied,
  or transient-I/O state fails with `500 project_trust_invalid`; a failed read
  never publishes an empty replacement over previously trusted roots. All
  in-process writers of the canonical ledger path share one queue. A writer
  validates the same exact version/row schema before publication: at most 8,192
  unique rows, canonical absolute non-NUL roots bounded to 16 KiB of UTF-8,
  canonical decimal device/inode members bounded to 64 digits, and exact ISO
  timestamps. It serializes the candidate once and admits at most the same
  inclusive 1 MiB; an invalid or one-byte-over candidate leaves the prior
  ledger bytes and trust state unchanged, and a later valid write may retry.
  Every bound-state read rechecks that identity and canonical cwd before any
  runtime or discovery consumer may use the sidecar. Consumers open the trusted root with
  `O_NOFOLLOW`, compare the open descriptor's device/inode with the receipt,
  and traverse every resource parent and file descriptor-relatively without
  following links. At the bound project root, instruction providers shadow in
  Ghost's fixed order: `.omp/AGENTS.md`, `.claude/CLAUDE.md`, `.agents/AGENTS.md`,
  `AGENTS.md`, then `CLAUDE.md`; Ghost injects the first admitted regular file
  only. Pi receives the resulting context/skills/rules as exact arrays and
  null/empty active-repository, watchdog, and passive-advisor inputs;
  its baseline system prompt includes only instruction bodies, unconditional
  `alwaysApply` rule bodies, and compact skill/discoverable-rule indexes. No
  lexical post-load filter is an authority boundary.
  Project and ghost-file agent definitions are counted but inactive for the
  principal. A principal pi session performs no live/ambient agent discovery;
  its daemon-owned `task` tool selects a native coding harness and may pass an
  opaque requested agent name only to Claude Code. Machine-skill discovery is
  the explicit exception described above. Claude
  keeps native `skills:[]` and `settingSources:[]`; the SDK's `skills: "all"`
  option is not usable here because it is a context filter, not a path sandbox.
  Its custom Ghost system prompt includes the shared computer-use policy, the compact
  machine/ghost/project skill index, accepted ghost/project instruction files,
  and only rules explicitly marked `alwaysApply`; skill, conditional-rule,
  prompt, and Markdown-command bodies do not become always-active Claude
  instructions. Exact resource names still use Pi's
  project-over-ghost shadowing; a malformed project resource is rejected
  before that merge and cannot hide an accepted ghost sibling. Agent-definition
  content and executable project code enter neither runtime. This is
  declarative context, not Claude skill enablement, and cannot trigger later cwd
  discovery. `SessionHost.admitTurn` performs the first owner turn's one bounded
  project scan and Claude-specific MCP translation before an HTTP caller can
  publish SSE headers. The reservation freezes that admitted snapshot through
  query execution; Claude does not reopen project files between admission and
  launch. After the turn Claude stores those exact admitted project bytes and
  translated project MCP rows in its mode-`0600` resume sidecar.
  Every continuation, project-state read, and session listing opens that
  sidecar with `O_NOFOLLOW` and reads at most 16 MiB through the pinned
  regular-file descriptor. The file
  must have one link and mode exactly `0600`; device, inode, size, mtime, ctime,
  and the live pathname identity must remain unchanged across the read. Invalid
  UTF-8, replacement, mutation, and oversize sidecars fail closed. `created`
  and `modified` must each be the exact canonical string produced by
  `Date.toISOString()`; invalid or merely equivalent noncanonical timestamps
  fail during turn admission, before maintenance reservation or any Claude
  executable/auth probe. Before a
  stored project snapshot can reach the SDK, every MCP row must match exactly
  one complete serializable SDK stdio, HTTP, or SSE transport schema: the
  discriminator, allowed keys, and every nested value are validated, unknown
  fields are rejected, and the credential-free restrictions below are applied
  again. Every continuation and post-restart resume uses that validated stored
  snapshot without reopening project files; an older bound sidecar without the
  snapshot fails closed and requires a new conversation. Phase 1 admits only MCP
  rows whose persisted SDK translation is
  credential-free: any environment expansion, non-empty stdio `env`, remote
  header, auth/OAuth field, or URL userinfo/query/fragment rejects the turn with
  `409 claude_project_mcp_secrets_unsupported` as an ordinary HTTP response,
  before SSE, a query, or a Claude sidecar is created. The rejected admission
  does not mutate transcript or project status and releases cleanly for retry.
  Disabled rows are not translated. Ordinary credential-free stdio,
  HTTP, and SSE rows remain available; Ghost never expands an environment value
  into resume metadata. Because the Claude SDK cannot preserve MCP timeout
  values from 0 through 999 milliseconds, those rows are omitted with an
  MCP-specific warning and degraded project state. Values at least 1000
  milliseconds are preserved exactly. The same check is applied to stored rows
  before every resume, so older metadata cannot silently change timeout
  semantics.
  The sidecar retains general declarative-scan warnings separately from MCP
  scan/validation/translation warnings. General resource warnings remain
  visible diagnostics but do not degrade MCP health; only MCP-specific warnings
  or observed MCP connection failure make `mcpStatus` and project status
  `degraded`. A project with no admitted MCP rows remains `mcpStatus:"off"`.
- `PUT …/sessions/:id/project`
  `{ root: string|null, cwd?, trustToken?, expectedGeneration }` returns the
  full state. A non-null root requires the matching unused preview token; cwd
  must canonicalize to a directory inside it. `root:null` removes discovery;
  cwd stays current unless the caller supplies an absolute replacement (the
  shell's “Use Home” supplies the OS owner home). Every successful transition
  atomically increments `generation`. `POST …/project/reload`
  `{ expectedGeneration }` re-resolves the already-trusted declarative/MCP
  snapshot and increments it. For Pi, bind/reload writes and fsyncs a separate
  mode-`0600`, generation-qualified artifact containing the exact admitted
  instructions, skills, rules, prompts, Markdown commands, and MCP rows, then
  publishes the project-binding sidecar as the commit marker. Failure leaves
  the prior generation and live runtime intact; an obsolete generation is
  removed only after the new binding is durable. Pi recreation after cache
  eviction or daemon restart validates and loads the artifact and never
  rescans live project files. Missing, malformed, mismatched-identity, or
  wrong-mode artifacts fail closed with `project_snapshot_invalid`. The
  artifact's bounded bytes are decoded with fatal UTF-8 before JSON parsing, so
  an invalid byte inside an otherwise valid JSON string also fails as
  `project_snapshot_invalid` rather than entering a resumed Pi snapshot as a
  replacement character.
  Binding/reload closes an idle cached Pi session
  only after validation, the bounded scan, trust/state persistence, and atomic
  sidecar publication succeed, so a failed transition leaves the existing Pi
  session, MCP manager, and background jobs untouched. Publication is the
  commit: a later cached-session, MCP, or background teardown failure cannot
  roll back that durable generation or turn the successful mutation into an
  HTTP failure. Every cached Pi-session removal uses the same teardown gate,
  whether it came from an explicit/ordinary close, retention, a committed
  project mutation, or daemon shutdown. The old session is removed from the
  active cache and installed in that per-session gate before the first cleanup
  await. Concurrent attempts coalesce onto its in-flight teardown; a failure is
  logged where the initiating operation is best-effort and leaves the gate
  retryable. An explicit close, later project transition, repeated shutdown,
  or next open retries the exact retained session, and no replacement Pi
  runtime, MCP manager, collaboration/background owner, or voice transport is
  admitted until every cleanup branch succeeds. An open whose retry still
  fails is `503 session_cleanup_pending` and leaves the gate intact. Only an
  in-flight abort promise is coalesced internally and a rejected one is
  cleared; voice, collaboration, tool-cwd, Bash, abort, ask, title, MCP
  reload/disconnect/refresh/singleton, AgentSession, and model-runtime stages
  are marked complete only after that stage succeeds. Retried cleanup therefore
  does not repeat completed stages, and the gate is removed only after voice,
  collaboration, and Pi teardown all complete. Shutdown reports retained
  session cleanup failures and a repeated drain retries them. The next
  successful open receives the new immutable snapshot; no process-global
  reload occurs.
- `DELETE …/sessions/:id/project/draft` abandons only an unpublished,
  runtime-qualified pre-turn draft and returns
  `{ ok:true, id, conversationId, runtime, abandoned }`. The daemon refuses a
  transcript, cached/runtime session, Claude resume sidecar, legacy fork marker,
  or delete transaction with `409 project_draft_published|session_busy`; it never
  treats a published conversation as disposable draft state. A durable pending
  marker hides a cleanup in progress while Ghost removes only that draft's
  project binding, generation-qualified Pi snapshot, Pi tool-cwd sidecar, and
  outstanding preview receipts. Each required sidecar is verified absent and
  the sessions directory fsynced before a durable completion receipt is
  published and the pending marker retired. A failed cleanup retains the marker
  for an idempotent retry. The first completed request has `abandoned:true`;
  later retries of that same abandoned incarnation have `abandoned:false`.
  Previewing or binding the qualified id again removes the completion receipt
  and starts a new incarnation.
- Project mutations are serialized per runtime-qualified conversation and use
  optimistic generation. A stale value is `409 stale_generation`; a concurrent
  runtime-neutral turn admission, either runtime's open/close, or another
  mutation is `409 session_busy`. Admission is checked before preview mints a
  trust receipt and before bind/reload reads or writes project state; a Pi
  teardown therefore also blocks a Claude transition for the same raw
  conversation id. A syntactically invalid or
  relative root/cwd is `400 invalid_request`; a confined-open failure or cwd
  escape is `400 invalid_project_path|cwd_outside_project`; absent paths are
  `404 not_found`; missing/wrong/expired trust is
  `403 project_not_trusted|trust_token_invalid|trust_token_expired`. Claude may
  bind only before its first owner turn. Afterwards `canRebind:false` blocks
  PUT and reload with `409 project_rebind_requires_new_conversation`; the owner
  starts a new conversation to choose a different project. A draft binding pins
  the runtime-qualified id, so changing runtime before first send requires
  unbinding or a new draft id rather than silently transferring trust.
  Every message admission resolves the selected runtime once, before opening a
  runtime or publishing stream headers. If that selected runtime has no project
  binding while the opposite runtime's same raw conversation id is bound, the
  request is `409 project_runtime_mismatch`. This applies to every owner
  message, to unpublished draft ids, and to raw ids with rows in both runtimes;
  the refusal creates no selected-runtime transcript,
  sidecar, or cwd state. A binding is never inferred or transferred across the
  `pi:`/`claude-code:` qualification boundary.
  Whole-ghost rename/delete, conversation delete, and MCP reload/reconnect are
  mutually exclusive with a project transition in both admission orders.
  Runtime MCP health writes compare runtime, conversation id, canonical root,
  device/inode, and generation before replacing status, so a stale connection
  result cannot overwrite a newer binding.
  A bound project's MCP row owns a same-name server ahead of the ghost-home
  row even when the project row is disabled or malformed; it shadows rather
  than falling back to the lower-precedence server. The immutable project MCP
  snapshot stores that ordered set of claimed names separately from its
  admitted servers. Only enabled rows that pass the strict typed schema enter
  the admitted array or `resources.mcpServers` count. A disabled row claims its
  name without warning and a disabled-only project is initially
  `status:"ready", mcpStatus:"off"`; an invalid row claims its name, is omitted
  with a sanitized MCP warning, and makes initial bind/reload health
  `degraded`. Valid admitted siblings remain usable and count exactly once.
- `GET  /api/ghosts/:name/events` → an SSE stream of
  `{ type: "conversation-updated", id, conversationId, runtime, updatedAt,
  reason? }`
  invalidations. The daemon
  emits one after persisted conversation or read-state changes; clients refetch
  `GET …/sessions` rather than receiving a duplicated listing on this stream.
  It uses the same SSE headers and 15-second comment keepalive as turn streams.
  Disconnect or abort unregisters the listener and keepalive immediately, and
  subscribing never opens or retains an agent session. Project transitions and
  every completed Claude owner turn use `reason:"project"`, so the active shell
  refetches eligibility/status as well as the ordinary session listing.
- `PUT  /api/ghosts/:name/sessions/:id/pin` `{ pinned: boolean }` →
  `{ ok: true, pinned }` — pin or unpin one conversation, idempotently. Pin
  state lives in `sessions/pins.json` (atomic replace, never partial), works
  for pi and Claude Code conversations alike, and is owner state, not derivable
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
  last-opened ISO timestamp (atomic replace, never partial), works for pi and
  Claude Code conversations alike, and is owner state rather than something a
  transcript can derive. Version 2 stores public qualified ids. A version 1
  raw-id entry applies to every currently matching runtime row and is migrated
  to version 2 on the next owner-state mutation. A row is unread when it has
  `updatedAt` is later than `readAt`. An unknown conversation id is
  `404 not_found`; deletion drops its read entry, and stale ids are pruned on
  the next write.
- `PUT  /api/ghosts/:name/sessions/:id/title` `{ title: string }` →
  `{ ok: true, title }` — rename one conversation. The title is trimmed and
  written through the same `session_info` entry the smol lane uses
  (`SessionManager.setSessionName`); the background titler never writes over a
  name that is already set, so a rename is never undone by it. `title` in the
  response is the name as stored — pi collapses control characters and runs of
  spaces. A
  non-string title, a title that is empty after trimming or contains nothing
  printable, or one over 120 characters is `400 invalid_request`; an unknown
  conversation id is `404 not_found`; a Claude Code conversation is
  `409 not_supported`, because that runtime owns its own conversation's name.
  Renaming works while a turn is streaming — the title slot is not part of the
  conversation tree.
- `GET  /api/ghosts/:name/sessions/:id/jobs` → `{ jobs }` — the background
  jobs of that conversation as `{ id, label, command, status, startedAt,
  endedAt?, durationMs, exitCode?, output, outputTruncated }` rows, where
  `status` is `running`, `completed`, `failed`, or `cancelled`; a conversation
  that is not open has none (`[]`). Never opens a session.
- `POST /api/ghosts/:name/sessions/:id/jobs/:jobId/cancel` → `{ outcome, job }`
  — `outcome` is `cancelled` or `already_settled` with the job's current row;
  an unknown job or a conversation that is not open is `404 not_found`.
- `DELETE /api/ghosts/:name/sessions/:id` →
  `{ ok: true, trash: [{ artifact, source, trash, kind }, …] }` — moves every
  Ghost-owned artifact for the conversation to recoverable Trash. `artifact` is
  `omp-transcript` (the pi transcript; the label is kept for compatibility),
  `claude-sidecar`, `project-binding`, `project-snapshot`, `tool-cwds`, or
  `maintenance-state`, or `presentation-history`.
  Every generation-qualified Pi project snapshot is included. Claude Code's actual
  transcript remains in that runtime's
  external `~/.claude` storage; Ghost does not claim to delete it. An active
  turn or live-voice session must finish or be stopped first
  (`409 session_busy`); an unknown conversation returns `404 not_found`.
  Deletion writes and fsyncs a v3 tombstone before moving the first artifact.
  Each move first creates a private same-filesystem fallback Trash root, then
  journals its exact collision-free `{ artifact, source, trash, kind }` intent
  before rename. Resume reconciles the two authoritative locations: source-only
  performs the move, Trash-only completes its receipt, both is a conflict, and
  neither fails closed. Thus a crash after rename but before the receipt update
  cannot lose the destination. After every successful reconciliation Ghost
  atomically rewrites and fsyncs the tombstone with the complete ordered receipt
  so far.
  Before any reconciliation or cleanup, every v2/v3 row's artifact label and
  source must match the exact runtime/conversation-derived allow-list: the one
  Pi transcript or Claude sidecar, that runtime's binding and presentation
  history, and the Pi tool-cwd sidecar and generation-qualified snapshot names.
  Sources and destinations are globally
  distinct and completed receipts require source absent plus Trash destination
  present. A v3 pending move additionally requires the exact private
  `.trash/.conversation-<uuid>` root and its next sequential, collision-reserved
  direct child; aliases and another conversation's artifacts are invalid.
  Listings and every open/project route hide or refuse that runtime-qualified
  id while the tombstone exists, so a crash cannot expose a surviving sidecar
  or let the raw id bind again. Retrying DELETE resumes the transaction; the
  successful response includes both earlier and newly moved receipt rows.
  Legacy v1 tombstones remain resumable with an initially empty receipt, and v2
  accumulated receipts resume without a pending intent. The
  tombstone is removed and the sessions directory fsynced only after artifact,
  pin, and read-state updates settle.
  An invalid or unreadable exact tombstone stays pending, keeps the id hidden,
  and makes DELETE fail `500 delete_recovery_pending`; Ghost does not infer an
  empty receipt from untrusted marker bytes.
  DELETE claims the runtime-qualified conversation synchronously before its
  first marker inspection. Marker admission uses `lstat`: only `ENOENT` proves
  absence. A dangling link or permission/I/O failure at the draft-abandon
  marker remains authoritative and returns `409 session_busy`; the equivalent
  delete-marker state returns `500 delete_recovery_pending`. Neither case
  reads through, replaces, or removes the marker or conversation artifacts.
  Once the delete marker is present or indeterminate, the maintenance
  scheduler also retains a recovery-pending suppression after DELETE returns;
  only successful deletion or explicit durable marker retirement clears it.
  Upgrade recovery may permanently unlink an incomplete legacy fork: that
  conversation was never published to the owner and must not pollute Trash.
- `GET|POST /api/ghosts/:name/sessions/:id/live` owns realtime voice for one
  conversation through the `LiveVoiceManager` interface. GET returns
  `{ supported, active, phase, muted, inputLevel, outputLevel, transcript,
  error? }` without opening a session. POST accepts
  `{ action: "start"|"mute"|"unmute"|"stop" }`. The default implementation
  answers `501 not_supported` until the Ghost-owned port lands (issue #3).
  When active, a separate chat turn is refused from the moment
  voice startup claims the conversation until voice has fully stopped, and
  model rebinds and MCP reloads/reconnects defer across that same boundary and
  apply after voice releases the session. Claude Code returns
  `409 not_supported`.
- `GET  /api/remote/whoami` → `{ login, role, name? }` — the tailnet identity
  this request was admitted on, or `{ login: null, role: "owner" }` for a
  bearer-token caller. See "Tailnet identity" under Authentication.
- `GET|POST /api/remote` → the exact remote exposure status, or owner-only
  `{ enabled: boolean }` control persisted as `remote.enabled`.
- `GET /api/remote/qr.svg` → a no-store `image/svg+xml` QR code for the active
  remote URL; `404 not_found` while remote access is off.
- `GET /manifest.webmanifest` → the unauthenticated, icon-free manifest for
  installing the built-in viewer as a standalone app.
- `GET|POST /api/ghosts/:name/sessions/:id/collab` retains the legacy
  `CollaborationManager` compatibility boundary for an injected encrypted
  relay host. GET returns
  `{ supported, active, readOnlyUrl?, writableUrl?, participants }` without
  opening a session. Start is
  `{ action: "start", relayUrl?, writable, confirmed }`; stop is
  `{ action: "stop" }`. Ghost ships no host and plans no relay; the default
  implementation answers `501 not_supported`. The supported remote-sharing
  path is the built-in viewer over Tailscale Serve. When an injected host is
  active, a read-only start never returns the write-token URL; a writable start
  requires
  `confirmed: true` and returns a distinct capability whose holder may prompt or
  interrupt the model and thereby run the host ghost's tools with the host's
  local authority. Links are never logged or copied automatically. At most one
  host startup is admitted per conversation; concurrent starts coalesce, while
  stop, conversation close, and daemon shutdown wait for an admitted startup
  before stopping it. A writable remote prompt takes the raw-prompt ownership
  described by the MCP mutation contract before it enters the `AgentSession`;
  prepared MCP candidates cannot publish or disconnect its current manager
  until that prompt settles. The host is conversation-scoped and is stopped
  when that session closes. Claude Code returns `409 not_supported`.
- `GET  /api/ghosts/:name/sessions/:id/transcript` → `{ id, conversationId,
  runtime, title, messages, total, truncated }` — a past conversation's history
  so the shell can rehydrate
  it (issue #26). `messages` are pi's `{ role, content }` messages (user and
  assistant only; private `thinking` reasoning and internal tool-result messages
  are dropped, exactly as the live stream omits them), the same shape a
  pi-messages client renders. Paged with `?limit` (default 1000, max 2000) and
  `?offset`; `total` is the full renderable count and `truncated` is true when a
  page omits messages. Each message carries its opaque persisted `entryId` so a
  client can validate page assembly; Pi's parent graph is runtime-internal and
  is not exposed on this presentation API. Ask tool calls carry
  `ghostAsk` with `settled: "submitted" | "cancelled" | "timedOut" | "chat"`,
  always present and derived from the persisted tool result, so a restored ask
  card states how that question actually closed rather than assuming an answer.
  A tool call whose persisted result was an error also carries `failed: true`;
  the result messages themselves are dropped here, and without that bit a
  rehydrated transcript would show every recovered call as having succeeded.
  Absence of `failed` means “not known to have failed”; a call with no result
  at all (an abandoned turn) carries nothing.
  Every restored assistant tool-call part also carries `cwd: string|null`, read
  from the conversation's mode-`0600` tool-cwd sidecar. `null` means historical
  execution cwd is unknown and a client must not resolve a relative argument
  against ghost home or current cwd. Version 2 stores exact
  `{ version:2, cwds:[[toolCallId, absoluteCwd], ...] }` state in
  oldest-to-newest activity order. Recording an existing id removes and
  reinserts it at the newest position. The writer validates and serializes each
  entry once, then deterministically removes oldest entries until the complete
  file is at most the control reader's inclusive 16 MiB limit; if one
  pathological newest entry cannot fit, the readable empty map is published.
  An evicted id therefore restores as `cwd:null`. The reader accepts the prior
  version-1 object map, but every new publication uses the ordered version-2
  form and the same bounded atomic control-file writer.
  The daemon subscribes once to the raw AgentSession, so HTTP, collaboration,
  live-voice, and hook turns all record the execution-start cwd. It
  coalesces bursts into atomic fsynced replacements without clearing a dirty
  revision on failure. Normal HTTP adapters hold their one
  terminal `done|error` frame until the sidecar write has durably succeeded or
  bounded retries produce an explicit terminal persistence error. Raw-session
  terminal observation drives the same flush before conversation invalidation,
  and every session close retries any remaining dirty revision; per-HTTP
  adapters do not record a duplicate cwd.
  `404 not_found` for an unknown conversation id. Only pi
  conversations are readable here; a Claude Code conversation's transcript lives
  in that runtime's own storage.
- `GET /api/ghosts/:name/sessions/:id/ask` → `{ ask }`, where `ask` is the
  currently pending `ask` interaction or `null`. A pending ask carries `timeoutAt`
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
  ghost home holds only what makes that ghost that ghost. Ghost's own `ask`
  tool (`packages/daemon/src/ask-tool.ts`) hands the `AskBroker` that deadline
  per question, beneath the two things only the question knows: one that names
  its own `timeout` keeps it.
- Principal conversations expose no owner-facing mid-turn message queue. While
  a turn is streaming, the owner stops it before sending another ordinary
  message. Runtime-native delivery remains an internal mechanism for
  collaboration, live voice, and background-job results; it is not an HTTP or
  HUD interaction primitive.
- `POST /api/ghosts/:name/sessions/:id/stop` aborts the active principal turn
  for either runtime and does not return until that turn's admission, hooks,
  and persistence boundary have released. It returns `{ stopped: boolean }`;
  `false` means the conversation was already idle. The HUD keeps the current
  draft while this acknowledgement is pending, so the next ordinary send
  cannot race the old turn's settlement.
- Conversation branching and historical ask re-answer are not Ghost principal
  actions. The daemon exposes no branch, navigate, or re-answer route and never
  creates a fork transaction. Pi's native transcript graph remains private
  runtime state used only to resume the conversation's current leaf.
  For upgrade safety, startup, listing, and open still recognize pending v1/v2
  fork markers written by older Ghost releases. Recovery publishes an already
  complete artifact set or removes an incomplete unpublished set, then retires
  the marker only after verification and a sessions-directory fsync. A retained
  marker keeps the id hidden and busy. Recovery derives all final paths from the
  validated raw conversation id, admits only distinct lexical direct children
  with the expected pending suffixes, and performs no cleanup for an invalid
  relationship. This compatibility reader cannot create or clone a conversation.
- `POST /api/ghosts/:name/greeting` `{}` → `{ greeting: string | null,
  onboarding: boolean }` — one smol-lane completion (see below) writes a short
  in-persona opener for an empty chat from the character file, memory index,
  shallow Documents index, and the current time. `greeting` is `null` on ANY
  generation failure (no usable model, provider error, timeout, output rejected by
  validation) — never a 5xx; the shell keeps its static invitation and the
  greeting is pure upside. `onboarding` is true while `character.md` is
  missing, blank, or still byte-equal to the seed, and is recomputed per
  request even when generation fails. Character/onboarding, memory, Documents,
  and conversation-recency reads are independently best-effort: an unavailable
  input defaults only its own section, never discards successful siblings, and
  never exposes its error or path. An unreadable character fails closed to
  `onboarding: false`. Only an unknown ghost makes the endpoint fail. Cached per ghost (TTL ~10 min,
  single-flight), invalidated when `character.md` changes.

### The smol lane (the `smol_model` role)

One cheap, fast model role carries small raw completions that should not bill
like a chat turn. Three consumers today:

**Conversation titles.** After the first turn of a conversation completes, the
daemon generates a 3-6 word title from the first user message with one smol
completion, fire-and-forget: it never blocks the reply and a failure is logged,
never fatal. A conversation is titled once
and never re-titled. The title is the latest **`session_info` entry** in the conversation's own
`sessions/*.jsonl` transcript, written with `SessionManager.setSessionName` /
`appendSessionInfo`. It never enters the model's context, needs no sidecar, and
rides the same per-ghost storage backup and future encryption cover.
`GET …/sessions` surfaces it as `title`. A transcript written by the previous
OMP runtime carries its title in a fixed-width slot on line two plus
`title_change` entries; it is converted once, in place, the first time the
conversation is opened, and listing still reads that old slot for an
unconverted file.

The owner's own name for a conversation goes into the same entry
(`PUT …/title`). The arbitration is that the background titler runs once,
after the first turn, and never writes over a name that is already set.

**Greetings.** `POST …/greeting` (above) writes the empty-chat opener with one
smol completion: 1-3 sentences in the ghost's own voice, at most one timely
detail (time of day, a gap since the last conversation, something from memory),
ending with an invitation to talk. Character, memory-index, and root Documents
index inputs are fenced as untrusted data. The greeting's 1,200-character
Documents budget admits complete index lines only and states the exact total
omitted after combining the source-index cap with this tighter cut. Output that
answers instead of greeting is rejected outright, never truncated.

**Command-hook classification.** `ghostd hook-smol-complete` reads
`{ ghost_home, prompt }` from stdin and writes `{ text }` to stdout. It exists
for trusted machine command hooks such as the `session_stop` continuity
classifier. The command resolves the named ghost's normal smol lane and runs
one raw completion with no tools, transcript, session, or reasoning-effort
override; it never hardcodes a provider model.

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
pi and Claude Code runtimes alike — get a
"first meeting" system-prompt section: help with the owner's request first,
learn about them one question at a time during quiet moments, save stable facts
as memory, and eventually draft and write the character with the
`ghost_character` tool (read/write `character.md`). The populated character
file IS the completion latch — there is no separate onboarding state — and the
section stops being injected on the first session after the file deviates from
the seed.

### Harness status

`GET /api/ghosts/:name/harnesses` is the authenticated, read-only coding-harness
catalogue. It returns `{ harnesses }` in the fixed order `claude-code`, `codex`,
`pi`. A row is
`{ id, name, kind, nativeConfiguration, installation, authentication, reason,
usage }`, where `kind` is `native`, `installation` is
`installed | missing | unknown`, `authentication` is
`authenticated | unauthenticated | unknown`, and `reason` is a
bounded actionable string or null. `unknown` installation means the catalogue
could not complete its probe, not that it proved the executable absent.
`nativeConfiguration` is true for every row: a task launches the owner's
installed harness with its native user and project settings. The catalogue
resolves only the three known executable names, without a shell, and never
returns their absolute paths or raw probe errors. `GHOST_CLAUDE_BINARY`,
`GHOST_CODEX_BINARY`, and `GHOST_PI_BINARY` are explicit executable overrides.

Claude authentication comes from the existing short-lived
`claude auth status --json` probe and counts only the owner's `claude.ai` plan
login. A failed auth probe leaves Claude installation and authentication
`unknown`; only the executable resolver's categorical missing error establishes
`missing`. Codex authentication comes from a short-lived structured
`account/read` probe against the installed Codex app server. Any non-null native
account counts as authenticated; a null account is unauthenticated only when the
app server says OpenAI authentication is required. Probe or protocol failures
leave the state unknown. Omarchy's display record is deliberately not treated
as authentication evidence. Pi installation comes from resolving the native
executable. Its authentication remains `unknown` because Pi has no stable,
provider-neutral noninteractive authentication probe; native task startup is
authoritative.

Vendor `usage` is a bounded projection of Omarchy's existing schema-version-1
record in `$XDG_STATE_HOME/omarchy/agents/usage/<claude|codex>.json` (default
`~/.local/state/...`), read descriptor-pinned and never refreshed through a
provider API by Ghost. It is null for `pi`; otherwise it is
`{ source:"omarchy", state, updatedAt, stale, tier, status, help, limits,
today }`. `state` is `ready | missing | invalid`. A ready record older than 30
minutes, or more than five minutes in the future, is stale. Each bounded limit
is `{ label, usedFraction, resetsAt }`; `usedFraction` is utilization in `[0,1]`,
not a token balance. `today`, when the record has local counters, is
`{ totalTokens, prompts, sessions }` and is historical usage, not an allowance.
No per-model history, credential, provider response, executable pathname, or
raw record is exposed. A missing or malformed record never makes installation
discovery fail.

When task services are attached, both principal runtimes receive one stable
`# Delegation` system-prompt section. It names the three accepted harness ids,
the Claude-only optional agent selection, the durable task lifecycle, and the
requirement to pass the correct cwd. It contains no machine-status snapshot, so
its bytes remain cacheable across turns that do not change the Ghost persona.
Availability, authentication, current usage windows, and cwd-scoped native
agents are dynamic and enter model context only when the principal runs `ghost
delegation` through Bash. This local, daemon-independent command reads the two
Omarchy schema-version-1 JSON files described above, performs the native
installation/authentication probes, and queries the exact Claude Code agent
names selectable at its current cwd. Its default output is the compact
`# Delegation` projection: categorical harness states; each Claude/Codex limit
as integer percent remaining plus a short relative reset duration; and Claude
agent names with optional model aliases. `--json` returns the bounded structured
projection for scripts. The command does not refresh Omarchy; when a fresh
provider snapshot is actually needed the principal may first run `omarchy agent
usage update --limits-only claude codex`.

Claude inventory uses the installed executable and the Agent SDK's native
`supportedAgents()` control request with normal user/project/local/plugin
discovery, an empty streaming input, no model turn, no transcript persistence,
and a bounded timeout. At most 64 JSON-encoded names and optional bounded model
aliases cross the CLI boundary, with truncation explicit; native descriptions,
prompts, tools, and definition paths remain out. Discovery failure prints a
bounded unavailable marker and does not prevent use of the default Claude
agent. Codex and Pi have no selectable-agent inventory.

### Harness tasks

The daemon owns one persistent task lifecycle shared by all coding harnesses.
It does not own or translate their full transcripts. Each task is stored as one
mode-`0600`, atomically replaced v3 sidecar under the ghost home's `.tasks/`
directory. The machine-bound directory follows whole-home rename and deletion
but is excluded from export: records contain local project paths and opaque
native session ids that are meaningless or unsafe to resume on another
machine. A record contains the daemon-issued `task-<uuid>` id,
runtime-qualified parent conversation identity, coding harness id, optional
effective Claude Code agent name or null, complete bounded task prompt,
resolved canonical **source** project root and cwd, workspace view, state and
timestamps, optional
native session id, bounded terminal result or error, and a bounded normalized
event tail. V1 and v2 records retain their old `agent` worker id on disk;
reading maps `claude-code` and `codex` directly and maps `pi-worker` to the
`pi` harness, with no native agent requested. A v1 record additionally receives
the preserved legacy in-place workspace. Either old version promotes to v3 on
its next write; no native task is resumed.
The event tail retains at most 100 state/output/notice/owner-message/
principal-message events with monotonic sequence numbers; each event text is
at most 4,000 UTF-16 code units. Task prompts and terminal results are at most
64,000 and 128,000 code units respectively. Tail eviction, individual text,
result, and error-message truncation are explicit flags. A native session id is
never truncated; an invalid or oversized id fails the task. The harness's native
storage remains authoritative for richer history and configuration.

The exact pretty-printed UTF-8 sidecar, including its trailing newline, never
exceeds the private-file reader's 1 MiB ceiling. Before each atomic write the
store evicts the oldest normalized events while retaining the newest sequence;
if necessary it then truncates the terminal result. Those reductions set
`eventsTruncated` and `resultTruncated` respectively. The complete admitted task
prompt is never truncated. A record that still cannot fit is rejected rather
than writing state the daemon cannot read back.

Task states are `queued`, `starting`, `running`, `waiting_for_owner`,
`cancelling`, `completed`, `failed`, `cancelled`, and `interrupted`. The first
five are non-terminal; `waiting_for_owner` is an explicit reversible state, so
the owner or principal can send a follow-up message and return it to `running`
only after the worker accepts that message. Owner and principal messages retain
distinct event types. Cancellation first enters `cancelling`; it becomes
`cancelled` only after the captured native controller confirms the worker can
no longer continue. A failed cancellation remains `cancelling` with a bounded
error and the native task still blocks home moves; if that worker completes
despite the request, its honest terminal state is `completed`. A daemon restart
marks every previously non-terminal durable record `interrupted`; Ghost never
guesses how to reconnect an opaque vendor process. Malformed sidecars are
skipped by listings and rejected by direct reads. Tasks run concurrently
without a Ghost-level cap.

The harness is required. The Ghost principal chooses it using task fit plus any
installation, authentication, Omarchy usage, or Claude-agent context it reads
on demand through the native commands above; the daemon does not hide that
policy behind another router.
`agent` is optional and effective only with `harness:"claude-code"`, whose SDK
provides a direct selector. When omitted, the harness's default coding agent
owns the task and may delegate internally. If a caller supplies `agent` with
`codex` or `pi`, Ghost normalizes the durable field to null, records a notice
that the default agent will receive the task, and sends the complete assignment
unchanged. It never turns an unsupported selector into prompt instructions.
Ghost does not list configuration directories, validate agent existence,
snapshot definitions, translate model aliases, or restrict native tools. Native
agent definitions own model, effort, instructions, tools, skills, plugins, MCP,
and nested delegation; harness retry and fallback behavior remains native.

Every task has a workspace view
`{ strategy, state, root, cwd, branch, baseCommit, headCommit, review, notice }`.
`strategy` is `git-worktree | in-place`; `state` is
`preparing | active | removed | preserved`; and `review` is
`pending | ready | no_changes | needs_attention | not_applicable`. Task-level
`root` and `cwd` remain the trusted source checkout; workspace `root` and `cwd`
are where the worker actually runs. Commit ids are full lowercase hexadecimal
object ids, branch is the daemon-issued `ghost/task-<uuid>` local branch, and
every nullable field is explicit. The workspace view is present in complete
task views and list summaries.

For a bound project whose canonical root is exactly a non-bare Git worktree,
Ghost's default is one linked worktree per task under
`$XDG_STATE_HOME/ghost/task-worktrees/<repository-hash>/<task-id>` (default
`~/.local/state/...`), never under a ghost home. Before it admits the task,
Ghost requires the source worktree to be clean including untracked files and
pins its current `HEAD`. A bound root nested inside a larger Git worktree is
rejected rather than broadening the trusted project boundary; an unborn
repository is rejected because it has no committed snapshot. The v3 task
record, planned path, branch, and base commit are durable before `git worktree
add`. Under one short queue keyed by Git's canonical common directory, Ghost
rechecks the source cleanliness and exact pinned `HEAD` immediately before it
creates the branch/worktree. A racing change fails visibly and preserves any
uncertain artifact; Ghost never force-removes it.

The task cwd keeps its source-relative path inside the linked worktree. Native
workers still use the owner's normal user/XDG harness configuration and discover
project configuration from that execution cwd. The checkout contains Git's
committed snapshot and normal checkout/filter results; Ghost does not copy
ignored or untracked files, secrets, build outputs, or source-checkout-local
settings into it. Repositories that require such state must provide their own
worktree setup convention or commit the non-secret configuration. A directory
that is genuinely not a Git repository runs in place with an explicit notice
and no review artifact. Git being unavailable is an error for a root that
advertises Git metadata, not silent in-place execution.

After a successful worker process settles, Ghost verifies it is still on the
daemon-issued branch, stages the isolated worktree's remaining changes, and
creates one ordinary local commit using the owner's Git configuration and the
task id as its message. Existing worker commits are retained. Hooks and signing
configuration remain native; if staging, commit, validation, or cleanup fails,
the worktree is preserved with `review:"needs_attention"` and a bounded notice.
If the branch differs from the base and the worktree is clean, Ghost removes
only the linked worktree and retains the local branch with
`review:"ready"` plus its head commit. If there are no changes it removes the
clean worktree, deletes only the still-base task branch by expected object id,
and records `no_changes`. A failed or cancelled worker is never auto-committed:
clean/no-change worktrees are removed, a clean branch containing worker commits
is retained as reviewable, and dirty or uncertain work is preserved. Restart
interruption and emergency shutdown always preserve an existing workspace.

Tasks do not inherit another task's review branch: every isolated task starts
from the trusted source checkout's current `HEAD`, and this v3 wire has no
`from_task` or base-ref field. An assignment that needs implementation followed
by reviewer/simplifier agents must ask the selected native harness to perform
those stages inside the same task workspace. Cross-task or cross-harness staged
review requires a future explicit base-task contract; Ghost never guesses a
branch relation from task order or an agent name.

This is workflow isolation, not a sandbox. Maximum-trust workers can still
address the source checkout, machine, and configured remotes. Ghost does not
push, open a pull request, merge, or delete a review branch automatically;
remote publication is a separate explicit owner-authorized workflow. The
recorded branch, commit, path, and notice are the inspection/recovery boundary,
and ordinary Git commands remain the explicit way to merge, publish, retain,
or remove a preserved artifact.

Both principal harnesses expose the same daemon-owned logical tools:

- `task { harness, task, agent?, cwd? }` creates one durable task and returns
  its queued task handle after context admission and workspace provisioning.
  Harness execution is asynchronous. `harness` selects
  `claude-code | codex | pi`; optional `agent` is an opaque native Claude Code
  name and should be omitted for Codex and Pi. If present there, it is ignored
  as described above. The shape retains Pi's `{ agent, task }` vocabulary while
  making the responsible harness explicit and adding no mode or parent field.
- `task_list { limit? }` lists only tasks attributed to the current principal
  conversation, newest first. `limit` defaults to 10 and is bounded to 1–20.
- `task_get { task_id }`, `task_send { task_id, text }`, and
  `task_cancel { task_id }` inspect, steer, and cancel a task attributed to that
  same principal conversation. A principal send is durably distinguished from
  an owner send.

Ghost name and runtime-qualified parent identity are closure-bound by the
session and never model input. Task-control calls cannot reach a sibling
conversation's task. `task`, `task_send`, and `task_cancel` are mutating tools;
catalogue/list/get remain observational.
Tool-facing task projections retain at most 20 summaries, ten newest events
with 2,000 characters of text each, and a 32,000-character result preview; the
durable record and owner HTTP API remain authoritative for the full bounded
view. A principal turn or MCP call ending never implicitly cancels a created
task. The task remains daemon-owned and recoverable through its handle; the
principal does not poll in a tight loop or invent a completion it has not read.

Pi registers these as custom tools under the logical names above. The Claude
principal exposes them through its existing in-process `ghost` SDK MCP server,
so Claude sees `mcp__ghost__<name>`. It keeps the native Claude Code tool preset
but explicitly disallows native `Agent` and legacy `Task`: every principal
coding delegation therefore has the same durable handle, harness choice, usage
context, steering, cancellation, and parent attribution. This restriction is
principal-only; a `claude-code` task keeps its native Agent behavior.

The authenticated HTTP boundary is:

- `POST /api/ghosts/:name/sessions/:id/tasks` with exactly
  `{ harness, task, agent?, cwd? }` → the v3 task view with `202`. `harness`
  names the responsible native coding harness, `agent` optionally selects one
  of Claude Code's own agents, `task` is the complete assignment, and optional
  `cwd` refines the conversation's trusted project context. The
  qualified session id in the route supplies the durable parent identity;
  clients cannot override it. Rejecting every extra field is Ghost's stricter
  policy, not a claim that pi defines one universal subagent schema.
- `GET /api/ghosts/:name/tasks` → `{ tasks, skipped }`, with bounded summaries
  ordered by most recently updated first.
- `GET /api/ghosts/:name/tasks/:taskId` → the complete normalized task view.
- `POST /api/ghosts/:name/tasks/:taskId/messages` with exactly `{ text }` → the
  updated view, or a conflict when the selected native worker cannot currently
  accept steering.
- `POST /api/ghosts/:name/tasks/:taskId/cancel` with exactly `{}` →
  `{ outcome, task }`, where
  `outcome` is `cancelled | cancellation_requested | already_settled`.
  `cancellation_requested` means an abort was delivered while the native
  controller was still starting; the durable state remains `cancelling` until
  it confirms. `already_settled` also reports the honest terminal task when its
  result wins a race with native cancellation. Cancellation signals only the
  controller captured when that task was spawned; Ghost never discovers or
  kills processes by name.

The HUD has one ghost-scoped **Harnesses** destination. It reads the sanitized
machine harness catalogue and durable task list, fetches a selected task's
complete bounded view, and exposes the existing send/cancel reverse controls.
It does not present a second editable agent registry; native harnesses own that
configuration. Its machine-global catalogue route has no conversation cwd and
therefore does not guess or display the project-scoped Claude agent inventory;
the local `ghost delegation` command owns that cwd-scoped view. It polls
only while the destination is visible (three seconds for unsettled tasks,
thirty seconds for worker usage), retires every request on ghost change, and
renders task/result/event/workspace text literally. It does not provide a
parallel task-creation form: the owner delegates through the Ghost conversation
and the Ghost remains responsible for choosing the harness, assignment, and
trusted cwd. The HUD reports local branch/worktree artifacts but never turns
them into implicit publish, PR, merge, or cleanup actions.

The context resolver, not request input, is the authority for source project
root and cwd. It accepts only an absolute cwd within the conversation's
canonical, trusted project root. Every adapter revalidates that source machine
trust receipt and canonical containment immediately before launch, then runs at
the prepared workspace cwd and performs native project-policy/configuration
discovery there. An adapter that is not active returns `503
harness_unavailable` without changing this wire or persistence contract.

At daemon boot Ghost takes one in-memory snapshot of the launcher environment
before applying the principal provider scrub. Only installed coding-harness
processes and their installation/authentication probes receive that snapshot;
the Ghost principal retains the scrubbed environment. Values are
never logged, persisted, or returned by an API. This is the deliberate native
task-harness exception to provider isolation: it preserves CLI configuration selected
through environment variables as well as the owner's home/XDG configuration,
but cannot invent interactive-shell state that was absent from the service's
launcher environment.

The `pi` harness runs one captured process of the owner's resolved, installed
`pi` executable per task using Pi's native RPC JSON-lines protocol. Ghost does
not use its bundled principal SDK as a task runtime and does not supply the
ghost home's derived `.pi`, Secret Service model runtime, model roles, system
prompt, tools, or resource filters. The process receives the captured native
harness environment and task cwd, so Pi owns `~/.pi/agent`, authentication,
models, settings, packages, extensions, user/project agents, `AGENTS.md`,
skills, prompts, tools, project trust, transcripts, and fallback behavior.
Ghost supplies only RPC mode, the unchanged task, and a session name. Native
startup is authoritative for model and authentication
availability.

The complete task is always Pi's first ordinary prompt. Pi may use any native
internal delegation its installed configuration chooses, but Ghost never
requests a named agent through prompt text. An incoming `agent` field is
normalized to null before launch with the visible default-agent notice described
above. Project-local configuration is not an interactive trust boundary because
Ghost already admitted and revalidated the project before launch, and tasks run
with maximum owner trust.

RPC `prompt`/`steer` acknowledgements gate durable owner/principal messages;
`agent_settled` and the final root assistant message settle the task. Blocking
extension UI requests are cancelled rather than answered or left hanging;
fire-and-forget notifications may become bounded notices. Cancellation sends
native `abort`, closes stdin after acknowledgement/settlement, then escalates
`SIGTERM` to `SIGKILL` only for that captured process. Protocol framing splits
only on LF, as Pi requires. Unsupported or incompatible native RPC behavior
fails visibly rather than falling back to Ghost emulation.

The `codex` harness runs one captured process of the owner's resolved `codex`
executable per task using the native app-server JSON-lines stdio protocol. Ghost
does not bundle Codex, its SDK, generated protocol bindings, a model, or a
parallel agent loop. It invokes only `codex app-server --listen stdio://`, with
the captured native-harness environment and task cwd, initializes a narrow
client connection, then creates a persistent thread with `cwd` and the two
maximum-trust fields described below.
It does not override model, provider, service tier, personality, collaboration
mode, instructions, permission profile, history, skills, plugins, MCP servers,
hooks, rules, or user configuration. The deliberate worker-only exceptions to
that minimal thread start are `approvalPolicy:"never"` and
`sandbox:"danger-full-access"`, the app-server equivalents of Codex YOLO mode.
The complete task is always the first ordinary user input. The current
app-server protocol has no top-level custom-agent selector, so Ghost never
synthesizes a delegation instruction from `agent`; an incoming value is
normalized to null before launch with the visible default-agent notice described
above. Codex owns its
identity, prompt/tool guidance, `$CODEX_HOME` configuration and authentication,
project configuration, `AGENTS.md`, skills, plugins, rules, nested agents,
transcripts, and model/provider fallback behavior exactly as the installed
harness resolves them at that cwd. The app-server protocol is an explicit
experimental native dependency; an incompatible installed version fails
categorically rather than falling back to `codex exec` or Ghost emulation.

Ghost validates the effective cwd returned by `thread/start` and normalizes
completed Codex agent messages plus safe tool progress into the bounded task
event tail; returned permission/instruction-source diagnostics remain native
diagnostics rather than overrides. The Codex thread is the authoritative full
transcript and its `thread.id` is the opaque native session id. Task messages
use native `turn/steer` with the active turn-id precondition and are persisted
only after Codex accepts them.

The first Codex worker version has no owner-facing interactive approval or form
broker. Task messages never double as approval answers. Ordinary command, file,
and sandbox approval requests are intentionally eliminated by the maximum-trust
thread configuration; receiving one after Codex accepted that configuration is
a protocol failure rather than a reason to weaken or reinterpret the task.
MCP elicitation and any other request that needs information rather than
authority are conservatively declined when a typed decline exists. Unsupported
blocking client-host requests receive a JSON-RPC error so the native turn fails
visibly instead of hanging. Ghost never parses free-form yes/no text,
impersonates an interactive login, supplies external auth tokens or attestation,
or exposes Codex-only TUI/session navigation. A future interactive broker
requires a distinct typed pending-request and response contract keyed by native
request id.

Cancellation sends native `turn/interrupt` when a turn id exists, closes the
captured app server, then escalates `SIGTERM` to `SIGKILL` after bounded grace
periods. Startup/protocol/terminal outcomes settle only after that exact process
exits. Shutdown's force stage sends `SIGKILL` directly to the captured process,
including during initialization; no PID discovery or name-based kill is
permitted.

The `claude-code` harness runs one official Claude Agent SDK query per task,
always pointed at the owner's resolved, installed `claude` executable. The SDK
is only the typed streaming client already required by Ghost's optional Claude
principal runtime: the worker never selects the SDK package's bundled Claude
binary and never implements a parallel Anthropic agent loop. Ghost supplies
only the captured native-harness environment, canonical task cwd, installed
executable path, and the task as the first ordinary streaming user message. It
omits `settingSources` (thereby retaining Claude Code's native all-sources
default) and every model, fallback, system-prompt, tool, skill, plugin,
MCP, hook, allow/deny, sandbox, output-style, and settings override. As the
deliberate worker-only maximum-trust exception, Ghost supplies
`permissionMode:"bypassPermissions"` plus the SDK's required explicit
`allowDangerouslySkipPermissions:true`; any residual permission callback is
answered allow. Claude Code therefore owns its coding identity, native prompt
and tools, authentication, model and effort selection, user/project/local and
managed settings, `CLAUDE.md`, auto-memory, skills, plugins, hooks, MCP servers,
subagents, discovered permission rules, transcript, and fallback behavior as
the installed headless harness resolves them at that cwd, except that its
maximum-trust execution mode supersedes those rules where Claude permits. A
protocol incompatibility between the installed executable and SDK fails
visibly; Ghost does not fall back to a bundled executable or emulate Claude
Code. When `agent` is present, Ghost passes only that name through the SDK's
native `agent` option; Claude Code resolves the definition and applies its own
prompt, model, tools, and configuration. An unresolved name fails natively.

The separate principal-context discovery query uses the same resolved installed
executable, captured native-harness environment, cwd, and omitted
`settingSources`; it calls `supportedAgents()` before any user input and closes
the query immediately. It sets `persistSession:false` and cannot perform a
coding assignment. Native SessionStart/configuration discovery may still run,
because that behavior is part of the owner's Claude Code configuration rather
than a Ghost-owned scanner.

The worker validates the cwd reported by Claude Code's native `system/init`
message. That message's opaque session id identifies the task; Claude Code's
normal transcript under its own configuration directory is authoritative.
Root-assistant text and bounded native status are normalized into task events,
while the terminal `result` supplies the normalized task result. A task message
is written to the SDK's streaming input as another ordinary native user message
and is persisted only when Claude replays that exact message before the first
terminal result; it never changes settings or answers an approval. The first
terminal result closes the captured query and rejects every message still
awaiting replay, so a late acknowledgement cannot create or be recorded as a
second turn.

This is Claude Code's noninteractive/headless surface, not an emulation of its
terminal UI. Claude runs with maximum tool authority: it does not stop for
ordinary Bash, filesystem, web, MCP-tool, or subagent permission prompts. Native
hooks still run as harness behavior. Ghost supplies a typed `canUseTool`
fallback which allows any residual authority request. Requests that need
information rather than trust remain different: unhandled MCP elicitation is
declined and undeclared user dialogs fail closed. The replay-user-messages flag
used to acknowledge accepted task messages is transport policy, not agent
configuration. Ghost never parses free-form task messages as form or dialog
answers. Print mode has no workspace-trust screen; Ghost's independently
captured project binding and
immediate root/cwd revalidation are the admission boundary before native
project configuration can execute. Interactive login/onboarding, plan approval,
forms, URL-auth handoffs, session navigation, model/permission switchers,
IDE/TUI rendering, and other terminal-only flows must be completed in Claude
Code itself or await a future typed pending-request API. The maximum-trust
override intentionally supersedes a native default permission/plan mode for the
worker; it does not change the owner's stored Claude Code settings.

Cancellation closes streaming input, requests the SDK's native `interrupt`,
then closes the exact captured query after a bounded grace period. Query close
is also the registered forced-shutdown action and owns teardown of its spawned
Claude process and transports. Native initialization is accepted only after the
SDK has used Ghost's captured-process seam. Terminal success, worker error, and
cancellation settle only after the SDK stream ends and that captured process
has closed.

The captured root/cwd remain pinned for the task's lifetime even if its parent
conversation is later deleted; conversation deletion does not cancel tasks,
and the runtime-qualified parent becomes historical
attribution. A non-terminal task, or an accepted controller send/cancel still
draining after terminal state, blocks whole-ghost rename or deletion with `409
ghost_busy`. Once tasks and controller operations settle, their `.tasks/`
sidecars move with the home and remain readable under the new ghost name.
Shutdown synchronously closes task admission and aborts live controllers before
draining them under the daemon's existing bounded graceful/forced stages. If
the graceful deadline expires, each registered captured-worker force action is
invoked before its durable state becomes `interrupted`; every harness adapter
sends `SIGKILL` directly to only its captured child when its native graceful
shutdown cannot complete, including during initialization.

### Model indicator + switcher (which model a ghost uses, and switching it)

Provider models come from pi's model catalogue (`@earendil-works/pi-ai`),
cached in `.pi/models-store.json`. One runtime entry is code-owned:
`claude-code/default`, representing the installed Claude Code harness rather
than an API model. Its usability comes from the boolean result of external
`claude auth status --json`; no credential is read into or emitted from a
response.

- `GET  /api/ghosts/:name/model` → the current selection:
  `{ current: { provider, id, name?, contextWindow?, hasVision } | null,
  source: "role" | "default" | "none" }`. `role` — `roles.chat_model` is set
  and resolves among usable models; `default` — the catalogue default: the
  first catalogue provider's best-ranked model, taking providers in the order
  the catalogue declares them, then provider priority, newest version first,
  `-latest` before dated snapshots, then name; `none` — nothing usable,
  `current` is null. The same default is bound as `chat_model` after a provider
  login when chat is unset.
- `GET  /api/ghosts/:name/models?scope=available|catalog&provider=<id>&q=<search>&limit=<n>&offset=<n>`
  → `{ scope, models: [...], total, limit, offset, provider?, q? }`.
  - `scope=available` (default): models the ghost can use right now (from
    credentialed providers). Each row is
    `{ provider, id, name?, contextWindow?, cost?, hasVision, connectedVia?,
    current }`, tagged by `provider`, with `current: true` on the selected one.
    `connectedVia` is `oauth | api_key | claude_plan`.
  - `scope=catalog`: the full pi catalogue (every provider, logged in or
    not), same row shape plus `usable: boolean` (is the provider
    credentialed; `connectedVia` present only when usable). Supports the
    `provider` filter and a case-insensitive `q` substring match on id/name.
  - Both scopes are paginated. Providers keep catalogue order; within each
    provider, provider priority is respected and model families are ordered by
    descending semantic version/date, so current models appear before older
    ones. `limit` defaults to 100 and is capped at 500.
- `PUT  /api/ghosts/:name/model` `{ provider, id }` → set `roles.chat_model`.
  Validates the model exists in the pi catalogue or equals the
  code-owned `claude-code/default` runtime entry; an unknown model is a
  structured `400 unknown_model`. If the provider/runtime is not usable the
  write still happens and the response is `{ ok: true, usable: false, warning,
  current, source: "role" }` so the shell can prompt a login rather than the
  switch failing silently; a credentialed provider returns
  `{ ok: true, usable: true, current, source: "role" }`.

Requires `PUT` in the loopback CORS allow-list.

### Model roles and fallback chains

Model roles are Ghost-owned. `GET /api/ghosts/:name/model-routing` returns
`{ roles }` for every role: `chat_model` (`default`), `smol_model`,
`slow_model`, `vision_model`, `plan_model`, `designer_model`, `commit_model`,
`tiny_model`, `task_model`, and `advisor_model`. The older custom
`general_purpose_model` and `research_model` rows remain visible only when an
existing home has configured a primary or fallback for them. Each row is
`{ role, ompRole, label, primary, effective, source, fallbacks }`: `ompRole` is
the role's short name (`default`, `smol`, `slow`, …), kept under that field
name for compatibility; `primary` is the configured model; `effective`
includes Ghost's automatic resolution; and `source` is `explicit`, `auto`, or
`unavailable`. Automatic resolution is: `chat_model` explicit or the catalogue
default; `task_model`, `smol_model`, `slow_model`, and `designer_model` inherit
the chat default when unbound; `tiny_model` and `advisor_model` follow Ghost's
preference lists (tiny → haiku, nano, flash-lite, mini, flash, lite; advisor →
openai-codex gpt-5*, openai gpt-5*, anthropic opus, anthropic sonnet, gemini
pro); `vision_model`, `plan_model`, and `commit_model` stay unset until bound.
Models and fallbacks carry resolved/usable status.

`PUT /api/ghosts/:name/model-routing` accepts `{ role, target, provider, id }`
with `target: "primary" | "fallback"`; `{ role, target: "clear_primary" }`
removes an explicit primary, revealing automatic resolution; and `{ role,
target: "replace_fallbacks", fallbacks: [{ provider, id }, …] }` atomically
replaces, removes, or reorders the complete retry chain. The older
`clear_fallbacks` target remains accepted as an empty-chain compatibility form.
Vision primaries/fallbacks must accept images. `claude-code/default` is valid
only as the primary chat runtime because it is not a pi provider model.

Ghost persists this in `models.json` under `roles` and `fallbacks`. Fallback
chains are a Ghost concept stored there; nothing projects them onto a runtime
setting. A successful model selection returns immediately and the shell closes
the picker back to chat.

### Model login (`ghostd` drives pi's provider OAuth / API-key flows)

Signing a ghost into a provider is interactive and multi-step, so it is modeled
as a short-lived, pollable login session around pi's `ModelRuntime.login` and
`ModelRuntime.logout`. pi writes through Ghost's `GhostPiCredentialStore` into
the Ghost Secret Service schema at the selected service/account; a pasted
code, key, or token is never written below the ghost home, echoed in a GET
body, or logged.

- `GET  /api/ghosts/:name/providers` → `{ providers: [{ id, name, subscription,
  authTypes: ("oauth"|"api_key")[], loginLabel?, billingNote?, configured,
  connectedVia?, accounts: [{ account, configured, connectedVia? }] }] }`,
  derived from pi's provider table (openai-codex, openrouter, anthropic, github-copilot,
  xai, …). Ambient-only providers and the externally authenticated
  `claude-code` runtime are omitted.
- `POST /api/ghosts/:name/login` `{ providerId, authType, account? }` → `201`
  with the initial **login view** (below), including `loginId`.
- `GET  /api/ghosts/:name/login/:loginId` → the current **login view**: the step
  to show. Poll it.
- `POST /api/ghosts/:name/login/:loginId/input` `{ value }` → satisfy an awaiting
  prompt (a pasted code, an api key, or a selected option id) → the updated view.
- `DELETE /api/ghosts/:name/providers/:provider/accounts/:account` →
  `{ ok:true, providerId, account }` removes only that whole Ghost-schema
  service/account item, then applies the ordinary credential refresh boundary
  to live sessions. Another account and every ghost policy remain untouched;
  every ghost referencing the removed machine account fails closed until it is
  restored or logged in again.

The **login view** is
`{ loginId, providerId, account, authType, status, message?, authUrl?,
authInstructions?, deviceCode?, verificationUrl?, deviceExpiresInSeconds?,
prompt?, modelBound?, error? }` where `status` is one of `starting | working |
awaiting_url | awaiting_device_code | awaiting_input | awaiting_select |
succeeded | failed`, and `prompt` (when present) is
`{ kind: "text"|"secret"|"manual_code"|"select",
message, placeholder?, secret, options? }`. A callback-server flow carries an
`authUrl` AND a paste `prompt` at once (open the URL, or paste the code). On
`succeeded`, `modelBound` is set when the ghost had no chat model and one was
bound. `succeeded` is not published until the daemon has invalidated and rebuilt
the cached pi credential/model state for that ghost. Idle conversations update
before the terminal login view is visible; a conversation with an active turn,
live voice, or another exclusive owner records one coalesced refresh and applies
it at that owner's release boundary, never by changing credentials mid-turn.
Abandoned logins time out and are cleaned up server-side.

A live login belongs to the ghost home's filesystem identity, not to the
directory name captured when it started. Renaming the ghost therefore changes
the login routes to the new `:name` without interrupting the provider flow;
the keyring write is name-independent, and the successful policy/model write
resolves the current filesystem identity so it lands in the renamed home.
Deleting a ghost cancels and forgets its live logins but does not touch the
machine credential; reusing the deleted name cannot adopt the old live flow
because it is a different home.

The same flow runs in the terminal as `ghostd login [<ghost>] [--provider <id>]
[--account <name>] [--api-key]`.

### Claude Code plan runtime (external auth)

`roles.chat_model = { provider: "claude-code", modelId: "default" }` selects
the official Claude Agent SDK + an installed, unmodified `claude` executable.
The owner runs `claude auth login` outside Ghost. Ghost accepts no Claude
credential, stores no Claude credential, and removes ambient API/OAuth-token
variables from the subprocess environment.

The runtime uses the owner's local Claude Code authentication, built-in tools,
and web search in bypass-permissions mode. Ghost supplies the complete custom
principal system prompt instead of Claude Code's coding-agent system prompt,
while retaining the native tool preset and explicitly disallowing native
`Agent` and legacy `Task`. Filesystem
setting sources are pinned to `[]`: neither owner-home cwd nor a trusted project
may inject executable settings, hooks, or plugins. Every query's custom prompt
contains the Ghost character, derived indexes, shared Omarchy CLI-first, owner-deliverable,
Ghost self-documentation, coding-orchestration, runtime/cwd, and rendered
scheduled-work policies, compact machine/ghost/project skill index,
accepted instruction files, and rules marked `alwaysApply`, while keeping SDK
`skills:[]`; skill, conditional-rule, prompt, and Markdown-command bodies are not
injected into every turn. A bound project adds its stored accepted snapshot with
Pi's exact-name project-over-ghost shadowing and translates only its validated
native MCP rows into the SDK config.
Unbound sessions enable no cwd-discovered skills. Existing Ghost extension
tools are added through one in-process SDK MCP server, and output is normalized
back to pi-messages. Ambient provider credentials remain scrubbed.

Each turn is one scoped Agent SDK query. A new conversation uses its pre-turn project cwd,
or owner home while unbound. That choice is fixed at the first owner turn:
later PUT/reload is rejected and the shell must start a new conversation.
Every accepted metadata version stores exact canonical ISO `created` and
`modified` timestamps. Version-3 mode-`0600` metadata stores the actual cwd and the exact first-turn
project snapshot beside the opaque Claude resume id. A version-1 sidecar
predates cwd and resumes at ghost home for history safety; version 2 has cwd but
no project snapshot. Either legacy version may promote while unbound, but a
bound legacy resume fails closed rather than rereading mutable project inputs.
The runtime rebuilds the Ghost persona/memory/Documents prompt and visible
ghost declarative snapshot, reuses the stored project bytes and MCP rows,
streams one turn,
atomically writes metadata before the terminal event, and closes the query.
Claude Code owns the actual transcript under its own
`~/.claude/projects/` storage; the sidecar is not a transcript. Full rationale,
T3 Code provenance, policy caveat, and legal boundary:
[`docs/claude-code-runtime.md`](docs/claude-code-runtime.md).

Bind to `127.0.0.1`, and require the bearer token described under
[Authentication](#authentication) above. Loopback bind ≠ auth. Revisit the
whole model before any non-local exposure.

## Package boundaries

- `packages/extensions` — Ghost's built-in extensions plus ghost-home and
  machine Documents filesystem helpers. No HTTP, no daemon lifecycle, and no
  runtime package: extensions are written against the Ghost extension seam in
  `extension-api.ts` (`registerTool` with TypeBox JSON Schema parameters, the
  `before_agent_start` prompt hook, and a tool context of `cwd` plus an
  optional model), and the daemon adapts that seam to each session runtime
  (`packages/daemon/src/pi-extension-bridge.ts` for pi).
  Exports the extension factories and typed readers/writers.
- `packages/daemon` — per-ghost pi `AgentSession` and Claude Code query
  lifecycles, env scrubbing, model/runtime selection, the HTTP API, the
  read-only native-harness/Omarchy-usage catalogue, persistent normalized task
  lifecycle and harness-adapter seam, and the systemd unit. Vendor
  CLIs are detected on the machine and are not package dependencies. Depends
  on `extensions`. Both installed user services declare
  `WorkingDirectory=%h`; that sets process cwd only, while Ghost storage keeps
  its explicit roots. Daemon CLI operands still resolve relative to the caller's
  cwd when the CLI is launched directly. The Arch development package installs
  the daemon as the single self-contained `/usr/bin/ghostd` executable, with
  its Bun runtime and version embedded and no daemon source or `node_modules`
  tree. Both development and stable packages declare `fd` and `ripgrep` as
  runtime dependencies for pi's native search tools; the executable must not
  populate pi's cache by downloading them on demand.
- `packages/shell` — the Omarchy/Quickshell HUD, model routing, ask UI, live
  tool cards, and summoning indicator.
- `packages/chromium-extension` — the browser relay, driving tabs of the
  browser the user is already signed into. One extension serves every ghost and
  conversation over one socket, so the tab is the unit of isolation: relay
  protocol 2 requires every operation to carry its `session` id and every page
  operation the `tab` id that session opened. The extension keeps each tab's
  debugger attachment, isolated world, and console/network buffers separate from
  every other tab's, and each session's tabs separate from every other session's:
  `open` answers with the tab id, the `tabs` op lists and switches within the
  asking session's own tabs and answers `active` for it alone, and session
  `close` sweeps every tab that session opened rather than only its current one.
  The relay is the only browser: there is no second backend and no browser mode
  to choose. Browser calls fail with the disconnected message until an extension
  pairs. A ghost that needs Chromium running may start it from its shell, but
  must detach it from `ghostd.service` (`systemd-run --user --scope`): a child of
  that unit is killed with it, so `systemctl --user restart ghostd` would
  otherwise close the owner's browser and every tab in it. Cancelling a turn
  frees the caller, not the browser — the relay has no cancel frame, so an
  operation already handed to the extension runs to completion there. The
  session layer owns the URL policy, ref bookkeeping, read budget, and idle timer
  above the backend seam; per-request address pinning is gone with the backend
  that could intercept every request, so a name is resolved and checked before a
  navigation and every returned page URL is rechecked.
- `packages/desktop-helper` — Python, not pnpm. The fallback PyGObject sidecar
  for Hyprland/Wayland computer-use when Omarchy CLI cannot perform an action,
  driven by the `ghost_desktop` and `ghost_screen` extensions over line-oriented
  JSON on stdin/stdout. Managed with `uv`; the root `pnpm -r` scripts do not
  reach it.

## Daemon harness invariants

When `JOURNAL_STREAM` identifies the daemon's stderr device and inode, log
records go directly to the systemd journal with `PRIORITY` and
`SYSLOG_IDENTIFIER=ghostd`. String-valued `ghost` and `conversation` identity
become `GHOST` and `CONVERSATION`; every other record field remains only in
`MESSAGE`. Outside that exact stderr stream, logs retain their line-oriented
stderr format. Filter one ghost with
`journalctl --user -u ghostd GHOST=<name>`.

## pi harness invariants

- Scrub inherited env before session creation: stray provider API keys
  (e.g. `GEMINI_API_KEY`) silently add cloud models to a sovereign ghost. The
  scrub list is pinned against pi's env-key table and also removes
  `PI_CONFIG_FILES`, `PI_SHELL_PREFIX`, and `CLAUDE_CODE_SHELL_PREFIX`.
- Open every transcript with an explicit `SessionManager.open(file, sessionDir,
  cwd)` so nothing lands in `~/.pi`. Hand pi an empty transcript file at open so
  it persists every entry immediately; pi alone defers the file until the first
  assistant message, which would lose hook context that precedes one.
- Construct pi's `ModelRuntime` with Ghost's `GhostPiCredentialStore`. Secret
  Service items use Ghost's schema and exact configured service/account
  references only; cross-process refresh leases and revision-keyed caching live
  in Ghost's XDG-state metadata database so daemon and CLI opens coordinate
  without putting a bearer there. Nothing creates `agent.db`, `models.db`, or
  `models.omp.json` under `.pi/`.
- Render the persona/system prompt in Ghost and pass it as the loader's
  `systemPrompt`; the persona extension replaces it wholesale before every
  turn. Append only a runtime section derived from pi's structured current cwd,
  selected tool names, and registered one-line tool snippets. Never reintroduce inherited prompt prose,
  `APPEND_SYSTEM.md`, native context/skill rendering, prompt guidelines, or
  marker-based subtraction.
- Give `DefaultResourceLoader` `noExtensions`, `noPromptTemplates`, `noThemes`,
  and `noContextFiles`, set `projectTrusted` false, and enable native skills
  only for the explicitly supplied machine roots. Ghost supplies every other
  declarative category itself, as an explicit immutable snapshot from the
  visible ghost home plus one trusted project root. It supplies no
  `promptsOverride`, and every principal prompt disables prompt-template
  expansion; hidden compatibility providers are admitted only
  for a trusted project, and project and visible Ghost `tools/` code stay
  disabled. Ghost separately preloads only direct, non-hidden regular
  JavaScript/TypeScript entries from its visible `hooks/pre` and `hooks/post`
  as Ghost extension factories (the `extension-api.ts` seam: `registerTool`,
  `before_agent_start`), bridged to pi by `pi-extension-bridge.ts`. It opens
  the ghost root, hook directories, and final entry descriptor-relatively with
  `O_NOFOLLOW`, verifies regular-file identity, and imports the factory
  through the pinned descriptor, so a swapped pathname is never rescanned.
  Dot-prefixed entries are silently skipped before extension, type, or link
  checks; visible symbolic-link entries are rejected. These trusted
  ghost-owned in-process factories preserve Ghost hooks without admitting
  custom tools, owner-home code, or bound-project code.
- Use an in-memory `SettingsManager` carrying only `compaction`,
  `defaultTools`, and `enableSkillCommands: false`. Ghost's own `settings.yml`
  is read from the visible ghost home only and is never a pi settings file;
  the operational cwd defaults to owner home and supplies no configuration.
- MCP comes only from Ghost's explicit sources through `GhostMcpManager`: the
  ghost's visible `mcp.json` plus the bound project's native config. pi's own
  user/global config and Codex, Claude, Copilot, and other MCP sources are
  never discovered. This is a sovereignty invariant like env scrubbing.
- Register Ghost's tools directly as pi custom tools so `getActiveToolNames()`
  is the complete tool list; there is no separate mount.
- Tool approvals stay disabled; `ask` is never an approval prompt.
- Tools throw structured errors, not `isError` payloads.
- Parallel tool calls: wrap shared-file mutations in a file mutation queue.
- pi has no automatic titling, so `PI_NO_TITLE` is irrelevant; Ghost's smol
  lane owns the single persisted `session_info` title.
