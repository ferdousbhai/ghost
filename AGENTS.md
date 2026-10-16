# ghost

Local Omarchy-native AI persona with file-backed state, a daemon API, desktop shell, Bash browser automation, and computer-use MCP server.

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; an in-place edit of `CLAUDE.md` turns the link into a diverging copy.

## Authoritative contract

`CONTRACTS.md` defines the ghost-home layout, daemon API, the harness table, package boundaries, and lifecycle invariants. Read and update it with every contract change; do not duplicate those contracts here or in code comments. It stays trustworthy only through use: when you find a claim the code contradicts, fixing that drift (doc or code, whichever is wrong) is part of the task at hand, not a follow-up.

## Glossary

- **owner** — the one person this machine and its ghosts belong to. There is no other user role.
- **ghost** — one persona; **ghost home** — its directory under `~/ghosts/<name>/` (layout in `CONTRACTS.md`).
- **harness** — an agent CLI the owner already has (claude, codex, grok, pi, …); each conversation turn is one headless run of one, a row of `harness-table.ts`.
- **daemon** (`ghostd`) — the HTTP API that owns conversations; **HUD** — the Quickshell omarchy-shell plugin that talks to it.
- **ghost-desktop** — the computer-use MCP server (`desktop_look`,
  `desktop_act`); any MCP client can run it.

## Taste

Use the simplest design that makes correct behavior obvious. Follow
`CONTRACTS.md`'s product boundary: use existing CLI/skill and harness behavior,
justify new surfaces, and weigh dependencies by installed size. Delete
superseded machinery rather than preserving parallel implementations.

If a rule here fights the task in front of you, say so loudly and get sign-off before breaking it.

## The four ways to hurt yourself

1. **Testing against the live install.** Tests use scratch ghost homes, never `~/ghosts`, port 7717, or the owner's desktop. Daemon tests set `GHOST_DESKTOP=/usr/bin/false`; desktop checks use nested Hyprland with private runtime, D-Bus, and AT-SPI buses. The live install need not use this checkout: discover `systemctl --user cat ghostd.service`, `command -v ghostd ghost-desktop`, and `readlink -f ~/.config/omarchy/plugins/ferdousbhai.ghost` before deploying. A packaged daemon and HUD must be installed together; a checkout build alone ships nothing. See `docs/self-maintenance.md`. Restart `ghostd.service` for daemon changes and omarchy-shell for QML changes. Rescans and plugin disable/enable can reuse loaded Components, so they are not proof a change is live. Verify `ghost status`, installed artifacts, and the running shell's `debugBarGeometry`.
2. **Driving the HUD on the owner's desktop.** Enabling the plugin in the live `omarchy-shell`, or a plain `quickshell -p`, puts a mock ghost in the owner's real desktop. Verify shell changes only through `packages/shell/dev/preview.sh`, which runs a nested Hyprland and a nested omarchy-shell with private HOME, XDG dirs, and dbus, seeds the plugin there, and refuses the live port and `~/ghosts`. No headless QML platform either — window and bar behavior is what is being verified.
3. **Killing by pattern.** Several agent sessions share this checkout, and their processes carry this path in argv. Never `pkill -f`, `pgrep | kill`, or kill a PID found by name. Kill only a PID you captured at spawn.
4. **Touching a peer's git state.** The same shared checkout means `git stash` pops someone else's stash, so never stash here; commit or branch instead. A worktree and branch outlive their PR only while it is open: after the merge, `git worktree remove`, delete the branch locally and on origin, `git worktree prune`.

## Hit every surface

The common defect here is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Surfaces.** Daemon API, HUD (QML), `ghost-desktop` (its own repo; bump the pin in the root `package.json`). A behavior reachable from one is usually reachable from another.
- **Contracts.** Anything crossing a package boundary or the wire is in `CONTRACTS.md`. Change it first; the consumers follow in the same commit.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Pin needs unpin. A one-way door is a bug.
- **Prompt-visible policy.** The self-maintenance, scheduled-work, and similar policy sections, and the `ghost help <topic>` recipes they point at (`help-topics.ts`), are contract text the ghost acts on, not prose about the code. A change to restart, drain, unit naming, or CLI flags must keep those recipes true in the same commit. Every sentence the ghost reads is paid for on every turn: say each fact once, in the fewest exact words, cross-reference another section rather than restate it, and set the section's ceiling in `prompt-budget.test.ts` to its exact new size so growth is always a decision.
- **Docs.** Protocol changes land in `docs/hooks.md`, or in ghost-desktop's README for its host contract.

## Commands

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

Verify with the smallest proof: the test files you touched (`pnpm --filter <pkg> test <file>`) plus `typecheck` for the packages you changed. In a fresh worktree run `pnpm build` first: `@ghost/daemon` typechecks against `@ghost/extensions`' built declarations. Run the repo-wide gate only when asked, with one exception: a push to master runs it. The `pre-push` hook in `.githooks/` (installed by `pnpm install`) refuses a master push until `pnpm verify` — the whole gate, which the `Native packages` workflow also runs through the PKGBUILD on x86_64 and aarch64 — (workspace build, typecheck, lint, tests, `bun test scripts`, and the packaging checks that diff `packaging/arch/.SRCINFO` against `PKGBUILD`) has passed on that tree; run `pnpm verify` after the final commit so the push is instant, and never reach for `--no-verify` to get around a red result. An unreproducible gate failure is an open flake investigation (suspects: the timing-sensitive daemon stream-lifecycle tests) — record the failing test from `.git/ghost-verify-last.log` before re-running. Never run biome's `--write --unsafe`: its fix for an unused function is to rename it with a leading underscore, which silences the lint forever, so a `function _name` in a `src/` tree is dead code to delete, not a convention. A `PKGBUILD` edit regenerates `.SRCINFO` in the same commit (`makepkg --printsrcinfo > .SRCINFO` in `packaging/arch/`). Behavior changes ship with a focused test. The stable system-prompt policy text is budgeted by `packages/daemon/test/prompt-budget.test.ts`, so raising a ceiling there is a deliberate decision that has to be justified in the commit message.

The daemon runs on Bun (`engines.bun`), not Node. Work in this repository commits directly to `master`, as the owner instructed; do not open task PRs.
