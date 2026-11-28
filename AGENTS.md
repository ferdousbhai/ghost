# ghost

**Work resumed on 2026-11-24, with a narrower aim: one persona per machine, answered by a local model, that works with the owner's data through the apps that hold it. Ghost shows none of that data itself. No release, and no publish of the page, without the owner's go. Read `docs/status.md` before starting anything.**

Local Omarchy-native AI persona with file-backed state, a daemon API, a bar at the bottom of the screen, a page for reaching it from a phone, and Bash browser automation.

`CLAUDE.md` is a symlink to this file. Edit `AGENTS.md`; an in-place edit of `CLAUDE.md` turns the link into a diverging copy.

## Authoritative contract

`CONTRACTS.md` defines the ghost-home layout, daemon API, the local model's loop, package boundaries, and lifecycle invariants. Read and update it with every contract change; do not duplicate those contracts here or in code comments. It stays trustworthy only through use: when you find a claim the code contradicts, fixing that drift (doc or code, whichever is wrong) is part of the task at hand, not a follow-up.

## Glossary

- **owner** — the one person this machine and its ghost belong to. There is no other user role.
- **ghost** — a machine's one persona, reached from elsewhere over Tailscale; **ghost home** — its directory, `~/.local/share/ghost/` (layout in `CONTRACTS.md`); **character** — `character.md` there, the whole of who the ghost is.
- **local model** — the GGUF model ghostd runs and loops over; every turn runs on it. **coding agent** — an agent CLI the owner already has (claude, codex, agy), which the model runs from its shell.
- **daemon** (`ghostd`) — the HTTP API that owns the conversation; **bar** (`ghost-bar`) — the prompt near the bottom of the screen with the answer above it, a client of it. Ghost has no window. **page** — summonghost.com (`packages/web`), the client on a phone.
- **conversation** — the one continuous exchange between the owner and the ghost; there are no threads.
- **turn** — one owner message and all the ghost does in answer to it; **pass** — one run of the model's loop inside a turn (a hook's continuation or a follow-up starts another).
- **follow-up** — text sent while a turn runs, which becomes that turn's next pass.
- **handoff** — the background pass, near the model's context limit, that brings the topic documents up to date and writes the note later turns are handed in place of the conversation before it.
- **topic documents** — `topics/*.md` in the ghost home, one per topic the conversation has dealt with: the ghost's own memory, which outlives the conversation. The owner-shared memory is the `Notes` folder of their Documents.

## Taste

Use the simplest design that makes correct behavior obvious. Follow
`CONTRACTS.md`'s product boundary: use existing CLI/skill behavior,
justify new surfaces, and weigh dependencies by installed size. Delete
superseded machinery rather than preserving parallel implementations.

If a rule here fights the task in front of you, say so loudly and get sign-off before breaking it.

## The three ways to hurt yourself

1. **Testing against the live install.** Tests and canaries use scratch ghost homes, never `~/.local/share/ghost`, port 7717, the owner's hooks, or the owner's desktop; the bar's checks use `packages/bar/dev/qa.sh` (a private broadway display) against a scratch ghostd. This is the rule; the canary recipe, and how to find, deploy to, restart and verify the live install (which need not use this checkout: a checkout build alone ships nothing), are in `docs/self-maintenance.md`.
2. **Killing by pattern.** Several agent sessions share this checkout, and their processes carry this path in argv. Never `pkill -f`, `pgrep | kill`, or kill a PID found by name. Kill only a PID you captured at spawn.
3. **Touching a peer's git state.** The same shared checkout means `git stash` pops someone else's stash, so never stash here; commit or branch instead. A worktree and branch outlive their PR only while it is open: after the merge, `git worktree remove`, delete the branch locally and on origin, `git worktree prune`.

## Hit every surface

The common defect here is a change that works on the path you tested and is missing everywhere else. Before calling work done, walk this list and say which entries applied:

- **Surfaces.** Daemon API, `ghost` CLI, the bar, the summonghost.com page (`packages/web`, rules in its README), the local model's tools. A behavior reachable from one is usually reachable from another.
- **Contracts.** Anything crossing a package boundary or the wire is in `CONTRACTS.md`. Change it first; the consumers follow in the same commit.
- **Reverse states.** If you added a way in, add the way out and the way to see it. Starting over needs Trash. A one-way door is a bug.
- **Prompt-visible policy.** The system prompt's policy sections and the `ghost help <topic>` recipes its Ghost section indexes (`help_topics.rs`) are contract text the ghost acts on, not prose about the code. A change to restart, unit naming, or CLI flags must keep those recipes true in the same commit. Every sentence the ghost reads is paid for on every turn: say each fact once, in the fewest exact words, cross-reference another section rather than restate it, and set its size in the one budget test in `packages/daemon/src/prompt_policy.rs`, which holds every section and the tool descriptions at their exact sizes, so growth is always a decision.
- **Docs.** Protocol changes land in `docs/hooks.md`.

## Commands

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --locked -- -D warnings
cargo test --workspace --locked
cargo build --release --locked
bash packages/bar/dev/qa.sh
bash packages/web/check.sh
```

Verify with the smallest proof: the tests you touched (`cargo test -p ghostd --locked <name>`, or `-p ghost-bar`; the bar's scripted QA is `packages/bar/dev/qa.sh`) plus `clippy` for the packages you changed (`cargo clippy -p ghostd --all-targets --locked -- -D warnings`). Run the repo-wide gate only when asked, with one exception: a push to master runs it. The `pre-push` hook in `.githooks/` (set once per clone with `git config core.hooksPath .githooks`) refuses a master push until `.githooks/verify` — the whole gate, whose tests the `Native packages` workflow also runs, inside the package build, on x86_64 and aarch64 for each master push — (format, lints, a release build, tests, the bar's scripted QA, the page's checks, and the packaging checks) has passed on that tree; run `.githooks/verify` after the final commit so the push is instant, and never reach for `--no-verify` to get around a red result. An unreproducible gate failure is an open flake investigation (suspects: the timing-sensitive daemon stream-lifecycle tests) — record the failing test from `.git/ghost-verify-last.log` before re-running. Behavior changes ship with a focused test. Raising a size in the prompt budget test is a deliberate decision that has to be justified in the commit message.

The daemon and the bar are Rust, in one cargo workspace at the repository root; `packages/web` is the summonghost.com page, plain files published only on the owner's go (`packages/web/publish.sh`). Work in this repository commits directly to `master`, as the owner instructed; do not open task PRs.

## Cloudflare CLI

Use the `cf` CLI alone for Cloudflare work in this repository (the page's
Worker, its domains and DNS): no Wrangler, as a command, a config file or a
dependency. Find commands with `cf cli search "<what you want to do>"`, then check
`<command> --help`.
