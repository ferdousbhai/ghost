# Native coding workers

Ghost is the principal: it understands the owner, uses the desktop and browser,
chooses a coding worker, supplies a trusted project cwd, and remains responsible
for the outcome. A worker keeps its coding harness's own identity and project
behavior. The authoritative lifecycle and trust rules are in
[`CONTRACTS.md`](../CONTRACTS.md#worker-tasks).

## Task workspaces and review

For a clean, committed Git project, Ghost creates one linked worktree and one
local `ghost/task-<uuid>` branch per coding task. The worker starts at the same
project-relative cwd inside that worktree, so its native project instructions,
skills, plugins, hooks, and settings are discovered normally. The owner's
source checkout remains untouched. Ignored and untracked source files are not
copied into the task worktree; projects that depend on them need an explicit
worktree setup convention.

On success, Ghost stages any remaining worker changes and creates one ordinary
local commit, preserving commits the worker already made. A changed, clean
branch is retained for review and its linked worktree is removed. A no-change
task removes both. Failed or cancelled dirty work is never auto-committed and
is preserved at the path reported in the task's `workspace` view; restart and
emergency interruption preserve the workspace too. A genuinely non-Git
project runs in place with an explicit notice.

Ghost does not push, open a pull request, merge, or delete a review branch.
Those are separate owner-authorized actions. A worktree is workflow isolation,
not a security sandbox: maximum-trust workers can still use the machine,
source checkout, network, and configured remotes.

## Owner view

The HUD's ghost-scoped **Workers** destination shows the sanitized worker
catalogue, Omarchy usage snapshots, and durable tasks. Selecting a task exposes
its bounded assignment, events, terminal result, and local workspace artifacts.
The owner can send a follow-up to the exact native session or cancel it there.
The pane intentionally has no task-creation or publishing controls: delegation
begins in conversation, and push, pull request, merge, review-branch deletion,
and preserved-worktree cleanup remain separate explicit workflows.

## Codex

The Codex worker requires an installed `codex` executable. Ghost starts one
native app-server process per task at the task cwd; the initial assignment is
ordinary user input. It does not choose a model, inject Ghost's
character or memory, or replace Codex's prompt. The one deliberate override is
maximum execution trust: `approvalPolicy:"never"` plus
`sandbox:"danger-full-access"`, matching Codex YOLO mode. Codex otherwise loads
the same user config, authentication store, project
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

Headless tasks support native in-flight steering and interruption. Maximum
trust removes ordinary approval prompts; receiving one anyway is a protocol
failure. Forms, login, MCP elicitation, and other TUI-only flows still cannot be
invented from trust and fail closed. Run `codex login` directly for
authentication. A future interaction UI needs a typed request/response API
distinct from free-form task steering.

## Claude Code

The Claude Code worker requires the owner's installed `claude` executable.
Ghost uses the official Agent SDK only as a streaming client for that exact
executable; it does not use the SDK package's bundled binary. The task is an
ordinary user message at the selected cwd. Ghost does not append its character
or memory and does not set a model, fallback, prompt, tools, agents, skills,
plugins, hooks, MCP servers, sandbox, output style, or settings layer. The one
deliberate override is maximum tool trust through `bypassPermissions`. By
leaving `settingSources` unset, the installed harness uses its normal
all-sources default: managed, user, project, and local settings plus the native
`CLAUDE.md`, auto-memory, skills, plugins, hooks, MCP, subagent, and permission
discovery for that cwd.

`GHOST_CLAUDE_BINARY` may select the executable. It receives the same captured
daemon-launch environment described above for Codex. Its full transcript stays
in Claude Code's native store; Ghost persists the opaque Claude session id and
only bounded task events and the terminal result.

This is Claude Code print/streaming mode, so terminal UI is not present. Claude
does not stop for ordinary tool approvals, and any residual authority callback
is allowed. Native hooks still run. Unhandled MCP elicitation is declined and
user dialogs fail closed because they need information, not permission. Task
follow-ups remain ordinary user messages, never approval answers. Ghost records
a follow-up only when Claude replays it before the terminal result; a replay
that loses that race is rejected. Print mode has no workspace trust screen, so
Ghost's independently captured project binding is the admission boundary before
native project configuration runs.
Login/onboarding, interactive forms, plan approval, URL authentication, and TUI
session/model/permission controls must be completed in Claude Code itself. The
maximum-trust override intentionally supersedes an owner-configured default
permission or plan mode for this worker without changing the stored setting.

Cancellation first uses Claude Code's native interrupt and then closes the one
captured SDK query. An installed CLI/SDK protocol mismatch fails the task; there
is no fallback to the SDK-bundled executable or to a Ghost-owned Claude loop.

## Status and usage

The worker catalogue probes Codex through its structured account API and Claude
through `claude auth status --json`, then reads Omarchy's existing usage
snapshots. Ghost does not refresh provider limits or treat the Omarchy display
record as proof of authentication. Absolute executable paths, account details,
credentials, and raw provider records are not returned by the daemon API.
