# ghost

Local Omarchy-native AI persona with file-backed state, a daemon API, desktop shell, browser relay, and computer-use sidecar.

## Authoritative contract

`CONTRACTS.md` defines the ghost-home layout, daemon API, model roles, package boundaries, and harness invariants. Read and update it with every contract change; do not duplicate those contracts here or in code comments.

## Code index

- `packages/daemon/src/server.ts` — HTTP API and authentication boundary
- `packages/daemon/src/session-host.ts` — session lifecycle and runtime orchestration
- `packages/daemon/src/models.ts` and `packages/daemon/src/model-catalog.ts` — model selection and catalog
- `packages/daemon/src/hooks.ts` and `packages/daemon/src/claude-code.ts` — harness hooks and Claude Code runtime
- `packages/extensions/src/` — pure Ghost extensions (the `extension-api.ts` seam) and ghost-home file operations; `packages/daemon/src/pi-extension-bridge.ts` adapts them to pi
- `packages/shell/qml/` — Quickshell HUD and desktop UI
- `packages/chromium-extension/extension/` — opt-in browser relay
- `packages/desktop-helper/src/ghost_desktop_helper/` — Python computer-use sidecar
- `docs/hooks.md`, `docs/claude-code-runtime.md`, and `docs/DESKTOP_HELPER.md` — runtime protocols

## Commands

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

The root workspace commands do not cover `packages/desktop-helper`; run its `uv` checks from that package when it changes.
