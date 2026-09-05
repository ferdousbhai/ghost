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
- [`models.ts`](src/models.ts), [`model-selection.ts`](src/model-selection.ts) —
  roles and chat-model selection
- [`mcp-manager.ts`](src/mcp-manager.ts) — the ghost's MCP servers
- [`hooks.ts`](src/hooks.ts) — awaited harness hooks
- [`jobs.ts`](src/jobs.ts) — foreground/background Bash lifecycle
- [`context-windows.ts`](src/context-windows.ts) — pi context rollover and `history`
- [`cli/main.ts`](src/cli/main.ts) — `ghost` HTTP client commands

Detailed external protocols have one home:

- [Claude Code runtime](../../docs/claude-code-runtime.md)
- [hooks](../../docs/hooks.md)

## Persistent state

The character and conversations live in the ghost home. Notes, knowledge,
plans, and tasks live in the owner's XDG Documents directory, which both
runtimes read and write with their native file tools. The daemon has no memory
store, document index, notes API, plan mode, or todo store. Active background
jobs remain conversation runtime state.

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
HUD. Run `ghost help` or `ghost skill` for the current command catalog.
