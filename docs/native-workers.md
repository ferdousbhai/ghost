# Native coding workers

Ghost is the principal: it understands the owner, uses the desktop and browser,
chooses a coding worker, supplies a trusted project cwd, and remains responsible
for the outcome. A worker keeps its coding harness's own identity and project
behavior. The authoritative lifecycle and trust rules are in
[`CONTRACTS.md`](../CONTRACTS.md#worker-tasks).

## Codex

The Codex worker requires an installed `codex` executable. Ghost starts one
native app-server process per task and supplies only the task cwd; the initial
assignment is ordinary user input. It does not choose a model, inject Ghost's
character or memory, replace Codex's prompt, or override permissions. Codex
therefore loads the same user config, authentication store, project
`AGENTS.md`, skills, plugins, hooks, rules, MCP servers, and fallback behavior
that its installed version normally discovers at that cwd.

`GHOST_CODEX_BINARY` may select an absolute executable or a name on the daemon's
launch-time `PATH`. Ghost preserves the daemon launcher's environment for
installed vendor workers before scrubbing ambient provider credentials from
principal sessions. This cannot reproduce variables that exist only in an
interactive shell and were never imported into the user service environment.

The app-server protocol is currently experimental upstream. Ghost fails an
incompatible version explicitly and never falls back to a bundled SDK or a
Ghost-owned Codex loop. Full Codex transcripts remain in Codex's native store;
Ghost persists only bounded task state, progress, result, and the opaque thread
id.

Headless tasks support native in-flight steering and interruption. They do not
yet broker interactive approvals, forms, login, or other TUI-only flows.
Approval and elicitation requests are declined conservatively; an unsupported
blocking request fails the task instead of hanging or being auto-approved. Run
`codex login` directly for authentication. A future approval UI needs a typed
request/response API distinct from free-form task steering.

## Status and usage

The worker catalogue probes Codex through its structured account API and reads
Omarchy's existing usage snapshot. Ghost does not refresh provider limits or
treat the Omarchy display record as proof of authentication. Absolute
executable paths, account details, credentials, and raw provider records are
not returned by the daemon API.
