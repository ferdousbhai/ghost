# `@ghost/daemon`

`ghostd` is Ghost's owner-local control plane. It owns ghost lifecycle,
conversation sessions, runtime adapters, models and credentials, MCP, hooks,
background jobs, authenticated HTTP/SSE, and the `ghost` terminal client.

The stable storage and API contract is in
[`CONTRACTS.md`](../../CONTRACTS.md). This README is only a code map and local
development guide.

## Code map

- [`main.ts`](src/main.ts) — daemon composition and process lifecycle
- [`server.ts`](src/server.ts) — authentication, routes, and wire validation
- [`session-host.ts`](src/session-host.ts) — Pi session lifecycle and runtime
  orchestration
- [`claude-code.ts`](src/claude-code.ts) — native Claude Code adapter
- [`pi-extension-bridge.ts`](src/pi-extension-bridge.ts) — runtime-neutral
  extension adapter
- [`models.ts`](src/models.ts), [`model-catalog.ts`](src/model-catalog.ts) —
  roles, selection, and model catalog
- [`mcp-manager.ts`](src/mcp-manager.ts) — explicit Ghost/project MCP
- [`hooks.ts`](src/hooks.ts) — awaited harness hooks
- [`jobs.ts`](src/jobs.ts) — foreground/background Bash lifecycle
- [`tasks.ts`](src/tasks.ts), [`native-task-scope.ts`](src/native-task-scope.ts)
  — durable native-worker lifecycle and exact systemd-scope ownership
- [`*-task-adapter.ts`](src/pi-task-adapter.ts) — Pi, Codex, and Claude Code
  native protocol adapters
- [`cli/main.ts`](src/cli/main.ts) — `ghost` HTTP client commands

Detailed external protocols have one home:

- [Claude Code runtime](../../docs/claude-code-runtime.md)
- [hooks](../../docs/hooks.md)
- [keyring credentials](../../docs/keyring.md)

## Persistent state

Character and private memory live in the ghost home. Owner-visible knowledge,
notes, plans, and tasks live in the owner's XDG Documents directory, which both
runtimes read and write with their native file tools; an Obsidian vault there is
a folder of Markdown. The daemon has no document index, notes API, plan mode, or
todo store. Active background jobs remain
conversation runtime state.

## Local development

Install workspace dependencies from the repository root, then run focused
checks from this package:

```sh
pnpm --filter @ghost/extensions build
pnpm --filter @ghost/daemon typecheck
pnpm --filter @ghost/daemon test
```

The daemon runs on Bun. Tests must use a scratch ghosts root and ephemeral port.
Never point a development daemon at `~/ghosts`, never contact the live port
7717, and never restart the owner's `ghostd.service` from a test or coding
session.

For a terminal-facing smoke test, use `ghost smoke`; it creates disposable
state and can run without a provider turn:

```sh
ghost smoke --no-turn --json
```

## Runtime notes

Pi uses Ghost's explicit transcript, model runtime, prompt, declarative
snapshot, and MCP sources. Claude Code uses its installed native harness and
authentication while receiving the same Ghost persona and policy append. The
daemon scrubs ambient provider credentials before Pi construction; Claude's
reviewed child environment is captured separately.

The `ghost` CLI edits nothing directly. It discovers the daemon token, calls
the authenticated HTTP API, and renders the same conversations and jobs as the
HUD. `ghost delegation` is the exception: it performs a bounded, read-only
probe of the owner-installed Pi, Codex, and Claude Code worker harnesses without
opening daemon or ghost state. Run `ghost help` or `ghost skill` for the current
command catalog.

Principal sessions can supervise native workers only from a currently trusted
project. Ghost persists bounded task progress under `.tasks/` and owns the
worker's exact systemd user scope; each harness keeps its native project,
skills, agents, MCP, tools, and authentication behavior.
