# ghost

Local Omarchy-native AI persona with file-backed state, a daemon API, desktop shell, browser relay, and computer-use sidecar.

## Authoritative contract

`CONTRACTS.md` defines the ghost-home layout, daemon API, model roles, package boundaries, and harness invariants. Read and update it with every contract change; do not duplicate those contracts here or in code comments.

## Glossary

- **owner** — the one person this machine and its ghosts belong to. There is no other user role.
- **ghost** — one persona; **ghost home** — its directory under `~/ghosts/<name>/` (layout in `CONTRACTS.md`).
- **runtime** — the agent harness a conversation runs on: pi or Claude Code.
- **daemon** (`ghostd`) — the HTTP API that owns sessions; **HUD** — the Quickshell desktop shell that talks to it.
- **relay** — the opt-in Chromium extension; **helper** — the Python computer-use sidecar.

## Taste

Find the real constraint, then the smallest model that makes the correct behavior unsurprising. Do not preserve complexity because it already exists, and do not add machinery because it looks architecturally sound. When a runtime (pi, Claude Code) can own a behavior, it owns it: project policy through its settings and hooks rather than building a parallel loop; read its source in `node_modules` before writing a workaround, and name any deliberate exception in `CONTRACTS.md`. Ghosts run unthrottled: no concurrency, hosted-session, or provider-turn caps — surface limits as errors plus the runtime's retry and fallback chains.

If a rule here fights the task in front of you, say so loudly and get sign-off before breaking it.

## The three ways to hurt yourself

1. **Touching the live install.** `ghostd.service` and `ghost-shell.service` run on this machine against the owner's real ghost, `~/ghosts/dous`. Reading it is fine. Never start a daemon against it, never write into its `sessions/`, never contact `127.0.0.1:7717` from a test. Test against a scratch ghost home.
2. **Driving the HUD on the owner's desktop.** A plain `quickshell -p` joins the live session bus and puts a mock ghost in the real tray. Verify shell changes only through `packages/shell/dev/preview.sh`, which runs a nested Hyprland with private HOME, XDG dirs, and dbus, and refuses the live port and `~/ghosts`. No headless QML platform either — tray and layer-shell behavior is what is being verified.
3. **Killing by pattern.** Several agent sessions share this checkout, and their processes carry this path in argv. Never `pkill -f`, `pgrep | kill`, or kill a PID found by name. Kill only a PID you captured at spawn.

## Shared working tree

Other agent sessions edit this same checkout and branch concurrently.

- Stage by explicit file path. Never `git add -A`, `git add .`, or `git add <dir>`; they sweep a peer's untracked files and hunks into your commit.
- Check `git status` for `??` files and foreign hunks in shared files (`server.ts`, `server.test.ts`, `CONTRACTS.md`) before committing; stage only your own hunks.
- Finish one unit (code + tests green) → run `/simplify` and apply until nothing major remains → re-run tests → commit. One commit per unit; never batch.

## Hit every surface

The common defect here is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Runtimes.** pi and Claude Code each adapt the daemon differently (`session-host.ts`, `pi-extension-bridge.ts`, `claude-code.ts`). Runtime-shaped features need a decision per runtime, even if it is "not supported here".
- **Surfaces.** Daemon API, HUD (QML), relay extension, desktop helper. A behavior reachable from one is usually reachable from another.
- **Contracts.** Anything crossing a package boundary or the wire is in `CONTRACTS.md`. Change it first; the consumers follow in the same commit.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Pin needs unpin. A one-way door is a bug.
- **Docs.** Protocol changes land in `docs/hooks.md`, `docs/claude-code-runtime.md`, or `docs/DESKTOP_HELPER.md`.

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

Comments describe how a thing is used and move with the code; they are for functions, not for every line of behavior.

## Commands

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Verify with the smallest proof: the test files you touched (`pnpm --filter <pkg> test -- <file>`) plus `typecheck` for the packages you changed. Run the repo-wide suite only when asked. Behavior changes ship with a focused test. The root workspace commands do not cover `packages/desktop-helper`; run its `uv` checks from that package when it changes.

The daemon runs on Bun (`engines.bun`), not Node. After a build, the live install picks up changes only via `systemctl --user restart ghostd` — that is the owner's call, not yours.
