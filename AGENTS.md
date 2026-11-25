# ghost

**Work resumed on 2026-11-24, with a narrower aim: Ghost is the hub over the owner's own data. No release without the owner's go. Read `docs/status.md` before starting anything.**

Local Omarchy-native AI persona with file-backed state, a daemon API, a window, and Bash browser automation.

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; an in-place edit of `CLAUDE.md` turns the link into a diverging copy.

## Authoritative contract

`CONTRACTS.md` defines the ghost-home layout, daemon API, the local model's loop, package boundaries, and lifecycle invariants. Read and update it with every contract change; do not duplicate those contracts here or in code comments. It stays trustworthy only through use: when you find a claim the code contradicts, fixing that drift (doc or code, whichever is wrong) is part of the task at hand, not a follow-up.

## Glossary

- **owner** — the one person this machine and its ghost belong to. There is no other user role.
- **ghost** — a machine's one persona, reached from elsewhere over Tailscale; **ghost home** — its directory under `~/ghosts/<name>/` (layout in `CONTRACTS.md`).
- **local model** — the GGUF model ghostd runs and loops over; every turn runs on it. **coding agent** — an agent CLI the owner already has (claude, codex, agy), which the model runs from its shell.
- **daemon** (`ghostd`) — the HTTP API that owns conversations; **window** (`ghost-window`) — the GTK app that talks to it.

## Taste

Use the simplest design that makes correct behavior obvious. Follow
`CONTRACTS.md`'s product boundary: use existing CLI/skill behavior,
justify new surfaces, and weigh dependencies by installed size. Delete
superseded machinery rather than preserving parallel implementations.

If a rule here fights the task in front of you, say so loudly and get sign-off before breaking it.

## The three ways to hurt yourself

1. **Testing against the live install.** Tests use scratch ghost homes, never `~/ghosts`, port 7717, or the owner's desktop. Ghost has no screen control, so no test drives a desktop; window checks use `packages/window/dev/qa.sh` (a private broadway display) against a scratch ghostd. The live install need not use this checkout: discover `systemctl --user cat ghostd.service` and `command -v ghostd ghost-window` before deploying. A checkout build alone ships nothing. See `docs/self-maintenance.md`. Restart `ghostd.service` for daemon changes. Verify `ghost status` (no `restart needed` line: a restart that did not take leaves the old daemon answering under the same version) and the installed artifacts.
2. **Killing by pattern.** Several agent sessions share this checkout, and their processes carry this path in argv. Never `pkill -f`, `pgrep | kill`, or kill a PID found by name. Kill only a PID you captured at spawn.
3. **Touching a peer's git state.** The same shared checkout means `git stash` pops someone else's stash, so never stash here; commit or branch instead. A worktree and branch outlive their PR only while it is open: after the merge, `git worktree remove`, delete the branch locally and on origin, `git worktree prune`.

## Hit every surface

The common defect here is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Surfaces.** Daemon API, `ghost` CLI, the window, the local model's tools. A behavior reachable from one is usually reachable from another.
- **Contracts.** Anything crossing a package boundary or the wire is in `CONTRACTS.md`. Change it first; the consumers follow in the same commit.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Pin needs unpin. A one-way door is a bug.
- **Prompt-visible policy.** The system prompt's policy sections and the `ghost help <topic>` recipes its Ghost section indexes (`help_topics.rs`) are contract text the ghost acts on, not prose about the code. A change to restart, drain, unit naming, or CLI flags must keep those recipes true in the same commit. Every sentence the ghost reads is paid for on every turn: say each fact once, in the fewest exact words, cross-reference another section rather than restate it, and set the section's ceiling in the budget test in `packages/daemon/src/prompt_policy.rs` to its exact new size so growth is always a decision.
- **Docs.** Protocol changes land in `docs/hooks.md`.

## Commands

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --release --locked
bash packages/window/dev/qa.sh
```

Verify with the smallest proof: the tests you touched (`cargo test -p <crate> <name>`; the window's scripted QA is `packages/window/dev/qa.sh`) plus `clippy` for the packages you changed. Run the repo-wide gate only when asked, with one exception: a push to master runs it. The `pre-push` hook in `.githooks/` (set once per clone with `git config core.hooksPath .githooks`) refuses a master push until `.githooks/verify` — the whole gate, whose tests the `Native packages` workflow also runs, before building the package, on x86_64 and aarch64 — (format, lints, a release build, tests, the window's scripted QA, and the packaging checks) has passed on that tree; run `.githooks/verify` after the final commit so the push is instant, and never reach for `--no-verify` to get around a red result. An unreproducible gate failure is an open flake investigation (suspects: the timing-sensitive daemon stream-lifecycle tests) — record the failing test from `.git/ghost-verify-last.log` before re-running. Behavior changes ship with a focused test. The stable system-prompt policy text is budgeted by the test in `packages/daemon/src/prompt_policy.rs`, so raising a ceiling there is a deliberate decision that has to be justified in the commit message.

Both packages are Rust, in one cargo workspace at the repository root. Work in this repository commits directly to `master`, as the owner instructed; do not open task PRs.
