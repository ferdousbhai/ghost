# `@ghost/daemon`

`ghostd` is Ghost's owner-local control plane. It owns ghost lifecycle,
conversations, the local model and its loop, hooks,
authenticated HTTP/SSE, and the `ghost` terminal client. Each turn runs on a
model on this machine, whose one tool is a shell.

The stable storage and API contract is in
[`CONTRACTS.md`](../../CONTRACTS.md). This README covers local development.

## Local development

Install workspace dependencies from the repository root, then run focused
checks from this package:

```sh
pnpm --filter @ghost/daemon typecheck
pnpm --filter @ghost/daemon test
```

The daemon runs on Bun. Tests must use a scratch ghosts root and ephemeral port.
Never point a development daemon at `~/ghosts`, never contact the live port
7717, and never restart the owner's `ghostd.service` from a test. Deployment follows
[the maintenance runbook](../../docs/self-maintenance.md).

For a terminal-facing smoke test, use `ghost smoke`; it creates disposable
state and can run without a provider turn:

```sh
ghost smoke --no-turn --json
```

## Runtime notes

The `ghost` CLI edits nothing directly. It discovers the daemon token, calls
the authenticated HTTP API, and renders the same conversations as the window. Run `ghost help` for the current command catalog.
