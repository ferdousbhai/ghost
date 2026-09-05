# Concepts

The mental model behind Ghost: what a ghost is, where its state lives, which
surface owns what, and which absences are deliberate.

This page states intent and the decisions that are not obvious from reading the
code. [`CONTRACTS.md`](../CONTRACTS.md) is the normative boundary and the code
beside its tests is the behavior; both are linked from here rather than
restated. For the first install and first conversation, see
[getting-started.md](getting-started.md).

## One owner, one machine

Ghost has exactly one trust role: the owner of the machine it runs on. There is
no account system, no second user role, and no cloud copy of a persona. Remote
access exists only as the opt-in Tailscale Serve viewer, where the configured
owner has full access and admitted tailnet guests are read-only; remote access
never widens a ghost's local tool authority.

## Ghosts and ghost homes

A **ghost** is one persona. Its **ghost home** is one directory —
`~/ghosts/<name>/` by default — and the directory name *is* the ghost's name.
Creating a ghost writes `character.md` and an empty `memory/`; everything else
in the layout appears when it is used
([`ghosts.ts`](../packages/daemon/src/ghosts.ts),
[`home.ts`](../packages/extensions/src/home.ts)).

- `character.md` is the persona: plain Markdown, no frontmatter, read fresh at
  the start of every session. While it is still the daemon-written seed, the
  ghost carries a first-meeting section that asks it to learn about the owner
  in the gaps and to show a character draft before writing one. Writing the
  file removes that section on the next conversation — onboarding ends by
  itself rather than by a flag ([`greeting.ts`](../packages/daemon/src/greeting.ts)).
- `memory/*.md` is *this ghost's private internal continuity*: subjective
  reflections and commitments about its own behavior, one thought per
  kebab-case file. It is not the owner's knowledge store, and no other ghost
  reads it. Limits, redaction, and the session-start index are in
  [`memory-file.ts`](../packages/extensions/src/memory-file.ts).
- Sessions, sidecars, and runtime scratch state live
  under the same home.

The home is the atomic lifecycle unit. Rename moves the directory (so every
conversation id stays valid); delete moves it to the freedesktop Trash. Ghost
never recursively removes a home, and neither operation touches credentials,
owner documents, trusted projects, screenshots, downloads, or timers.

## Three state scopes

Everything durable belongs to exactly one of three scopes. Choosing the wrong
one is the most common modelling mistake in this system, so the boundary is
enforced in the system prompt as well as in code
([`machine-skills.ts`](../packages/daemon/src/machine-skills.ts)).

| Scope | Holds | Owned by |
|---|---|---|
| Ghost-private | character, memory, conversations, settings, runtime sidecars | one ghost home |
| Owner-shared | notes, knowledge, decisions, plans, tasks | the owner's XDG Documents directory, read and written as ordinary files |
| External | trusted projects, downloads, screenshots, systemd user timers, credentials | the machine facility that already owns them |

Private memory is for the ghost's own continuity. Owner facts, preferences,
shared decisions, project knowledge, and durable tasks go to the owner's
documents, where the owner and every other ghost can see them. Finished
deliverables go to the destination the owner asked for — the documents
directory when none was named, and never into a ghost home.

### Documents, and what a vault is

The directory is resolved the way screenshots resolve the Pictures directory:
`XDG_DOCUMENTS_DIR`, then `user-dirs.dirs`, then `~/Documents`. Ghost never
hard-codes a path, never indexes the directory, and never injects any of it at
session start — the system prompt names the directory in one sentence, and the
ghost reads it with the runtime's native file and search tools when a request
may depend on it.

An Obsidian vault is a folder of Markdown, usually under Documents. Ghost reads
and writes those notes as ordinary files and leaves `.obsidian/` alone, so a
ghost is useful whether or not Obsidian is installed or running. If the owner
installed the `obsidian-cli` skill under `~/.agents/skills/`, ordinary
machine-skill discovery admits it and the `obsidian` CLI becomes one more tool;
the owner-context policy does not duplicate its contents. Vault content is
unaffected by creating, renaming, deleting, or uninstalling a ghost.

## Surfaces

| Surface | Owns | Code |
|---|---|---|
| `ghostd` daemon | sessions, state transitions, models, credentials, MCP, hooks, the HTTP API | [`server.ts`](../packages/daemon/src/server.ts), [`session-host.ts`](../packages/daemon/src/session-host.ts) |
| `ghost` CLI | a terminal client over that API — nothing else | [`cli/main.ts`](../packages/daemon/src/cli/main.ts) |
| Quickshell HUD | the Omarchy desktop surfaces: chat, roster, panes, tray, bar indicator | [`packages/shell/qml/`](../packages/shell/qml) |
| Chromium relay | the opt-in MV3 extension that lends the ghost the browser the owner already uses | [`packages/chromium-extension/`](../packages/chromium-extension/extension) |
| Desktop helper | the Python JSON-lines computer-use sidecar (AT-SPI, capture, input) | [`docs/desktop-helper.md`](desktop-helper.md) |

The daemon is the only session owner: one process owns a session, and every
other surface is a client. The CLI never edits a ghost home directly, and the
HUD never writes daemon-validated state (memory, character, control files)
behind the daemon's back — the workbench file editor is the one deliberate
exception, and it writes ordinary files at the owner's explicit direction.

Computer use is CLI-first: the ghost is told to discover a route with
`omarchy commands --json` and run `omarchy <group> <action>` through Bash, and
to reach for `ghost_desktop` / `ghost_screen` only when Omarchy has no route,
a route failed, or the work is inside an arbitrary application's window.
`ghost_browser` drives pages. The helper is the fallback, not the first move.

There is one browser. Until the owner pairs the relay with their own Chromium,
browser calls fail and say so — there is no second backend and no dedicated
ghost profile, because the tab is the useful isolation unit and a browser the
owner cannot see is a browser they cannot supervise. That also means the ghost
acts inside the owner's logged-in session; the extension's README states the
risk that carries.

## The two runtimes

A conversation runs on one of two agent harnesses. Conversation ids are
runtime-qualified (`pi:<raw>`, `claude-code:<raw>`).

- **Pi** is the default. Ghost builds the session explicitly: its own model
  runtime, credential store, settings, and resource snapshot, with pi's
  inherited system prompt, ambient config/MCP, and automatic credential
  discovery kept out. Pi's native file, search, Bash, steering,
  and branch behavior is kept; Ghost adds `ask`, background jobs,
  browser, screen, desktop, and MCP.
- **Claude Code** is optional and native-first: `claude-code/default` runs the
  official Claude Agent SDK against the owner's installed, unmodified `claude`,
  authenticated by any method its own CLI reports as logged in. Ghost never
  receives or stores that credential. Claude keeps its complete native preset —
  subagents, todos, planning, web tools, `AskUserQuestion` — and Ghost adds
  only what the preset lacks. Setup is in
  [claude-code-runtime.md](claude-code-runtime.md).

Both runtimes receive the same Ghost-owned context: character, private memory
index, first-meeting policy, computer-use policy, scheduled-work policy, and
owner-context policy. Owner questions, image understanding, and
browser/screen/desktop control work on both. The
runtime still owns its own mechanics, so the same ghost feels like itself on
either while working the way that harness works.

Two capability gaps are deliberate and stay visible in the API rather than
being papered over: Pi admits ghost-home *and* trusted-project MCP with secret
resolution, while Claude admits only credential-free project MCP its SDK can
represent; and ghost-home `hooks/pre` / `hooks/post` extension factories are
Pi-native executable extensions that do not enter Claude.

## Models and roles

`models.json` in the ghost home holds provider policy, role bindings, and
fallback chains. Provider logins live in pi's own file-backed store,
`.pi/auth.json` (mode 0600), so each ghost signs in on its own and a login
never leaves the ghost home. Credential values never enter logs or API
responses.

Roles let one ghost use different models for different jobs: `chat_model`,
`smol_model`, `slow_model`, `vision_model`, `plan_model`, `designer_model`,
`commit_model`, `tiny_model`, `task_model`, `advisor_model`. (`models.json`
also still accepts `general_purpose_model` and `research_model`, kept only so
an older home keeps its routing.) A role lives under `roles`, and its ordered
fallback chain under `fallbacks`, where the runtime supports one. Only
`chat_model` is load-bearing for a turn; the rest exist so adding a role later
needs no file migration.

- `chat_model` is the conversation. Unset, it resolves to the first model
  declared in `models.json`, and with nothing declared there at all, pi decides
  — its own settings, then its first available model. A successful provider
  login binds that default into the role when nothing has claimed it yet, so a
  fresh ghost is usable straight after login.
- `smol_model` serves titles, greetings, and trusted command-hook completions.
  Unset, it picks the cheapest usable model and treats an authenticated
  subscription as zero marginal cost. An explicitly bound but unusable
  `smol_model` fails loudly instead of quietly switching models.
- `vision_model` has no ghost-side default: reading an image is quality work,
  so the owner binds it rather than inheriting the cheapest model with eyes.
  Unbound, `slow`/`designer`/`task` inherit the chat model and `tiny`/`advisor`
  follow Ghost's preference lists.
- `claude-code/default` is valid only as the primary chat runtime. It is not a
  pi provider model and never a role fallback.

Ghosts run unthrottled. Provider, runtime, and context limits surface as typed
errors and use the runtime's own retry and fallback chains; Ghost adds no turn,
concurrency, hosted-session, or spend cap. Selection details live in
[`models.ts`](../packages/daemon/src/models.ts) and
[`model-catalog.ts`](../packages/daemon/src/model-catalog.ts).

## Extending a ghost

A ghost is extended with readable files, not code: instructions, skills, rules,
Markdown commands and prompts, MCP servers, and — for pi — trusted `hooks/pre`
and `hooks/post` factories in the ghost home. Machine skills under
`~/.agents/skills/` and `~/.pi/agent/skills/` enter at lowest precedence, then
ghost-home resources, then one explicitly trusted project. There is no
skill-name allowlist, and the admitted set is an immutable per-session snapshot
the owner can inspect through the session resources API.

Project trust is explicit and bound to the canonical filesystem identity, not a
path string. Project instructions, skills, rules, commands, and MCP are
data-only.

Hook protocol and the built-in review pipeline are in [hooks.md](hooks.md).

## Deliberate absences

If you expect one of these, it is missing on purpose:

- **No plan mode, todo store, or plan/todo API.** A runtime's native planning
  may exist inside a turn, but durable owner-visible plans and tasks belong in
  the owner's documents. There are intentionally no `/plan` or `/todo` routes
  and no plan or todo CLI verbs.
- **No second browser backend** and no separate ghost browser profile — the one
  paired Chromium, or no browser at all.
- **No executable project extensions.** Project plugins, executable hooks and
  tools, LSP, and custom subagents stay disabled until they have a per-session
  isolation boundary
  ([#31](https://github.com/ferdousbhai/ghost/issues/31)). `agents/*.md` is
  preview-only for pi; Claude keeps its own native subagents.
- **No ambient credentials.** Provider and cloud environment variables are
  scrubbed before the pi runtime is built; Ghost does not discover a credential
  the owner did not give it
  ([`env-scrub.ts`](../packages/daemon/src/env-scrub.ts)).
- **No document index.** The Documents directory is named in the prompt and
  read on demand; nothing about it is scanned or injected at session start.
- **No delegation subsystem.** No task records, worker scopes, or `/tasks`
  API; a ghost runs `pi`, `codex`, or `claude -p` from Bash when it wants a
  specialist.
- **No throttles**, as above.

## Where to go next

- [getting-started.md](getting-started.md) — install and first conversation.
- [design.md](design.md) — product goal and the decisions behind this model.
- [`CONTRACTS.md`](../CONTRACTS.md) — the normative wire, storage, and package
  boundaries.
- [hooks.md](hooks.md), [claude-code-runtime.md](claude-code-runtime.md),
  [desktop-helper.md](desktop-helper.md),
  [injection-defense.md](injection-defense.md) — one document per protocol.
