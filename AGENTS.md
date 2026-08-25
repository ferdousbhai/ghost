# ghost

Your ghost, on your machine. An AI persona with memory, notes, and tools, running
locally as an Omarchy-native desktop app, built on [pi](https://pi.dev).
Early construction. Apache-2.0.

## Delivery

Work on `master`; branches/PRs only if asked. For small/docs changes, lightweight checks
are fine; otherwise simplify the diff, fix blocking issues, run checks, then commit and
push `origin/master`.

## Rules

- **[CONTRACTS.md](CONTRACTS.md) is authoritative** for the ghost-home layout, the daemon
  HTTP API, model roles, package boundaries, and the OMP 18 harness invariants. Read it
  before touching a session, a route, or a package boundary. Change a contract
  deliberately, in one commit, with every consumer updated, and do not restate it here or
  in code comments.
- The harness invariants are the ones that fail silently rather than loudly: unscrubbed
  env quietly adds cloud models to a sovereign ghost, and `agentDir` does not redirect
  session storage. Check that list before debugging either symptom.
- Ghost home is plain files. Anything derivable (memory index, note catalog) is derived
  per session and never stored.
- `packages/desktop-helper` is Python on `uv`; the root `pnpm -r` scripts do not reach it.
  Run its tests separately.

## Packages

See [CONTRACTS.md](CONTRACTS.md) for the boundaries. Shorthand: `extensions` is pure OMP
extensions with no HTTP, `daemon` owns session lifecycles and the API, `shell` is the
Quickshell HUD, `chromium-extension` is the opt-in "my browser" relay, and
`desktop-helper` is the Python computer-use sidecar.

## Commands

```bash
pnpm build          # pnpm -r build
pnpm test           # pnpm -r test
pnpm typecheck      # pnpm -r typecheck
pnpm lint           # biome check .
```

`packages/desktop-helper` runs its own `uv` toolchain; run its tests separately.

## Docs

- [CONTRACTS.md](CONTRACTS.md) — data and API contracts
- [docs/hooks.md](docs/hooks.md) — awaited model-harness hooks
- [docs/claude-code-runtime.md](docs/claude-code-runtime.md) — Claude Code plan runtime
- [docs/DESKTOP_HELPER.md](docs/DESKTOP_HELPER.md) — sidecar protocol
