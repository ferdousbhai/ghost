# ghost

Local Omarchy-native AI persona with file-backed state, a daemon API, desktop shell, browser relay, and computer-use sidecar.

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; an in-place edit of `CLAUDE.md` turns the link into a diverging copy.

## Authoritative contract

`CONTRACTS.md` defines the ghost-home layout, daemon API, model roles, package boundaries, and harness invariants. Read and update it with every contract change; do not duplicate those contracts here or in code comments. It stays trustworthy only through use: when you find a claim the code contradicts, fixing that drift (doc or code, whichever is wrong) is part of the task at hand, not a follow-up.

## Glossary

- **owner** — the one person this machine and its ghosts belong to. There is no other user role.
- **ghost** — one persona; **ghost home** — its directory under `~/ghosts/<name>/` (layout in `CONTRACTS.md`).
- **runtime** — the agent harness a conversation runs on. There is one: pi.
- **daemon** (`ghostd`) — the HTTP API that owns sessions; **HUD** — the Quickshell omarchy-shell plugin that talks to it.
- **relay** — the opt-in Chromium extension; **helper** — the Python computer-use sidecar.

## Taste

Find the real constraint, then the simplest design under which the correct behavior is obvious. Do not preserve complexity because it already exists, and do not add machinery because it looks architecturally sound. The contract's first rule (`CONTRACTS.md`, "Product boundary") is that work here simplifies and never adds complexity: every change says what it deletes or why nothing could be, an external component comes in only as a replacement for machinery of ours, and a dependency is weighed by what it adds to the install as well as by the code it saves. pi already ships retries, permission policy, hooks, and tool loops — when it can own a behavior, it owns it, because a ghostd copy of the same machinery ends up fighting the runtime's version: express project policy through the runtime's settings and hooks rather than building a parallel loop, read its source in `node_modules` before writing a workaround, and name any deliberate exception in `CONTRACTS.md`. Ghosts run unthrottled: no concurrency, hosted-session, or provider-turn caps — surface limits as errors plus the runtime's retry and fallback chains.

If a rule here fights the task in front of you, say so loudly and get sign-off before breaking it.

## The three ways to hurt yourself

1. **Testing against the live install.** `ghostd.service` runs on this machine against the owner's real ghost, `~/ghosts/dous`, and the HUD runs inside the owner's `omarchy-shell` (there is no `ghost-shell.service` any more — the standalone unit went when the HUD became a plugin). Tests never start a daemon against it, write into its `sessions/`, or contact `127.0.0.1:7717`; they use a scratch ghost home. **The live units do not run from this checkout.** `ghostd.service` execs `~/.local/bin/ghostd`, an installed launcher that no package owns and that `pnpm build` here does not update; the HUD is an omarchy-shell plugin, and `~/.config/omarchy/plugins/ferdousbhai.ghost` symlinks to `~/src/ghost/packages/shell/qml` — a separate clone of this repo with its own object store; the computer-use helper is a third path, `ghost-desktop-helper` on PATH, a `uv tool` editable install of that clone's `packages/desktop-helper` (`uv tool list --show-paths` says which clone), spawned fresh by each daemon start. So a `pnpm build` plus a restart from here ships nothing: confirm where the live QML and binary actually come from before believing a change is live. Getting work in front of the running ghost means landing it in whichever tree those paths resolve to, then `systemctl --user restart ghostd.service` plus `omarchy-shell shell rescanPlugins`, and verifying with `ghost status` and a turn. **A rescan is not proof a QML change is live.** `syncPluginWidgets` in omarchy's `shell.qml` reuses the Component it already holds whenever the entry-point URL is unchanged — which is every ordinary edit — and `reloadPlugins()` silently early-returns while a previous reload is still flagged in progress, so repeated rescans can all be no-ops. Neither a rescan, a touch of the file, nor `omarchy plugin disable`+`enable` reliably replaces a loaded widget; only restarting omarchy-shell does. Read the running shell, never the tree: `omarchy-shell shell debugBarGeometry` reports each module's real size, so a widget still at its old dimensions is a widget that never reloaded.
2. **Driving the HUD on the owner's desktop.** Enabling the plugin in the live `omarchy-shell`, or a plain `quickshell -p`, puts a mock ghost in the owner's real desktop. Verify shell changes only through `packages/shell/dev/preview.sh`, which runs a nested Hyprland and a nested omarchy-shell with private HOME, XDG dirs, and dbus, seeds the plugin there, and refuses the live port and `~/ghosts`. No headless QML platform either — window and bar behavior is what is being verified.
3. **Killing by pattern.** Several agent sessions share this checkout, and their processes carry this path in argv. Never `pkill -f`, `pgrep | kill`, or kill a PID found by name. Kill only a PID you captured at spawn.
4. **Touching a peer's git state.** The same shared checkout means `git stash` pops someone else's stash (it once restored 94 long-deleted files across 78 conflicted paths), so never stash here; commit or branch instead. A worktree and branch outlive their PR only while it is open: after the merge, `git worktree remove`, delete the branch locally and on origin, `git worktree prune`.

## Hit every surface

The common defect here is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Surfaces.** Daemon API, HUD (QML), relay extension, desktop helper. A behavior reachable from one is usually reachable from another.
- **Contracts.** Anything crossing a package boundary or the wire is in `CONTRACTS.md`. Change it first; the consumers follow in the same commit.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Pin needs unpin. A one-way door is a bug.
- **Prompt-visible policy.** The self-maintenance, scheduled-work, and similar policy sections, and the `ghost help <topic>` recipes they point at (`help-topics.ts`), are contract text the ghost acts on, not prose about the code. A change to restart, drain, unit naming, or CLI flags must keep those recipes true in the same commit. Every sentence the ghost reads is paid for on every turn: say each fact once, in the fewest exact words, cross-reference another section rather than restate it, and set the section's ceiling in `prompt-budget.test.ts` to its exact new size so growth is always a decision.
- **Docs.** Protocol changes land in `docs/hooks.md` or `docs/desktop-helper.md`.

## Code index

- `packages/daemon/src/server.ts` — HTTP API and authentication boundary
- `packages/daemon/src/session-host.ts` — session lifecycle and runtime orchestration
- `packages/daemon/src/models.ts`, `model-selection.ts`, `model-routing.ts`, `smol.ts` — model roles, the chat-model binding, and which model a role resolves to
- `packages/daemon/src/hooks.ts` — harness hooks
- `packages/extensions/src/` — pure Ghost extensions (the `extension-api.ts` seam) and ghost-home file operations; `packages/daemon/src/pi-extension-bridge.ts` adapts them to pi
- `packages/shell/qml/` — Quickshell HUD and desktop UI
- `packages/desktop-helper/src/ghost_desktop_helper/` — Python computer-use sidecar
- ghost-core is `packages/{daemon,extensions}`; ghost-omarchy is `packages/{shell,desktop-helper}`; the browser extension is its own repository — sides, seams, and rule are contracted in `CONTRACTS.md` under Package boundaries
- `docs/concepts.md` — decisions and deliberate absences; `docs/hooks.md` — the owner command-hook protocol; `docs/desktop-helper.md` — the sidecar protocol

Comments describe how a thing is used and move with the code; they are for functions, not for every line of behavior.

## Commands

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Verify with the smallest proof: the test files you touched (`pnpm --filter <pkg> test -- <file>`) plus `typecheck` for the packages you changed. Run the repo-wide gate only when asked, with one exception: a push to master runs it. The `pre-push` hook in `.githooks/` (installed by `pnpm install`) refuses a master push until `pnpm verify`, which is exactly what the Arch workflow runs (workspace typecheck, lint, tests, the packaging checks that diff `packaging/arch/.SRCINFO` against `PKGBUILD`, and the desktop helper's `ruff`, `mypy`, and `pytest`), has passed on that tree; run `pnpm verify` after the final commit so the push is instant, and never reach for `--no-verify` to get around a red result. An unreproducible gate failure is an open flake investigation (suspects: the timing-sensitive daemon stream-lifecycle tests) — record the failing test from `.git/ghost-verify-last.log` before re-running. Never run biome's `--write --unsafe`: its fix for an unused function is to rename it with a leading underscore, which silences the lint forever, so a `function _name` in a `src/` tree is dead code to delete, not a convention. A `PKGBUILD` edit regenerates `.SRCINFO` in the same commit (`makepkg --printsrcinfo > .SRCINFO` in `packaging/arch/`). Behavior changes ship with a focused test. The stable system-prompt policy text is budgeted by `packages/daemon/test/prompt-budget.test.ts`, so raising a ceiling there is a deliberate decision that has to be justified in the commit message. The root workspace commands do not cover `packages/desktop-helper`; run its `uv` checks from that package when it changes (`pnpm verify` includes them).

The daemon runs on Bun (`engines.bun`), not Node. The live install picks up a daemon build via `systemctl --user restart ghostd.service`, and a HUD change via `omarchy-shell shell rescanPlugins` — which often will not take, so confirm against the running shell and restart omarchy-shell when it does not (see "Testing against the live install").
