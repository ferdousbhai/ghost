# `@ghost/daemon`

`ghostd` is Ghost's owner-local control plane. It owns ghost lifecycle,
conversations, the choice of harness for each turn, MCP configuration, hooks,
authenticated HTTP/SSE, and the `ghost` terminal client. Each turn is a
headless run of an agent CLI the owner already has; the harness brings its own
model, credentials, and tool loop.

The stable storage and API contract is in
[`CONTRACTS.md`](../../CONTRACTS.md). This README is only a code map and local
development guide.

## Code map

- [`main.ts`](src/main.ts) — daemon composition and process lifecycle
- [`server.ts`](src/server.ts) — authentication, routes, and wire validation
- [`session-host.ts`](src/session-host.ts) — turns, harness choice and
  fallback, conversation metadata, ghost lifecycle
- [`harness-table.ts`](src/harness-table.ts) — one row per agent CLI: launch
  flags and output parser; [`harness-process.ts`](src/harness-process.ts) runs
  one; [`harnesses.ts`](src/harnesses.ts) judges eligibility from Omarchy's
  usage records
- [`conversation-log.ts`](src/conversation-log.ts) — the history every client
  reads
- [`prompt-policy.ts`](src/prompt-policy.ts) — the stable system-prompt
  policy sections
- [`mcp-catalog.ts`](src/mcp-catalog.ts) — the ghost's `mcp.json`
- [`hooks.ts`](src/hooks.ts) — the owner's command hooks around each pass
- [`cli/main.ts`](src/cli/main.ts) — `ghost` HTTP client commands

Detailed external protocols have one home:

- [hooks](../../docs/hooks.md)
- [ghost-desktop](https://github.com/ferdousbhai/ghost-desktop#readme)

## Persistent state

The character and conversations live in the ghost home. Notes, knowledge,
plans, and tasks live in the owner's XDG Documents directory, which the runtime
reads and writes with its native file tools. The daemon has no memory store,
document index, notes API, plan mode, todo store, or job table — background work
is a detached shell command that ends in `ghost say --follow-up`.

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

The `ghost` CLI edits nothing directly. It discovers the daemon token, calls
the authenticated HTTP API, and renders the same conversations as the HUD. Run `ghost help` for the current command catalog.
