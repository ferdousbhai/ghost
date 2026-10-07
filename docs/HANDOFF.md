# Handoff: simplify loop until convergence

Open work for whichever agent picks this repo up next, on any harness. Read
`AGENTS.md` and `CONTRACTS.md` first; they bind everything below. Delete this
file in the commit that records convergence.

## Objective

The owner asked: simplify and clean up the codebase until a fresh scan
reveals nothing else to fix. Eight rounds ran on 2026-10-07 (the owner capped
that session at eight). It did **not** converge: rounds 4–8 each still found
one to four real bugs. Continue the loop until one full, fresh round finds
nothing that clears the bar.

## State at handoff

- `master` at `0883b61c`, pushed. The live install (`~/src/ghost`,
  `ghostd.service`, the omarchy-shell HUD plugin) runs that commit.
- Nothing uncommitted, no open branches or worktrees.
- Sibling repo `~/github.com/ferdousbhai/keep-going` (the owner's stop hook)
  is clean and pushed; it is not part of this loop.

## How to run one round

1. Read the **current** files of everything changed since `1c77ca9c`
   (`git log 1c77ca9c..HEAD`), then sweep the whole repo (packages/daemon,
   packages/extensions, packages/shell, docs, CONTRACTS.md).
2. The bar: a real bug, fixed with a focused test that fails before the fix,
   or a change that is clearly simpler (deletes something). Not lateral, not
   cosmetic. Anything that changes product behavior or a contract is a
   proposal for the owner, not a change.
3. Verify with the smallest proof (`AGENTS.md`, "Commands"): the touched test
   files, `pnpm --filter <pkg> typecheck` when TypeScript changed, `pnpm
   lint`, and `bash packages/shell/dev/test.sh` for any shell change.
4. Commit each fix on `master` as `simplify round N: <what>`, the body saying
   what was deleted or fixed. Check `git diff --cached` first: the checkout is
   shared with other sessions.
5. A round that finds nothing changes nothing. That is convergence: then run
   `pnpm verify`, push, deploy (below), delete this file, and say so in the
   commit.

## Where the bugs were

Nearly every finding in rounds 4–8 was one of these; hunt them first:

- **Races between the idle chain and the owner.** The idle chain lives in
  `packages/daemon/src/session-host.ts` (`scheduleHandoff`, `runHandoff`,
  `countDownNextWork`, `cancelHandoff`, `cancelNextWork`). Check it against
  every owner action: send, queue, stop, delete, ghost rename, conversation
  or ghost switch, daemon shutdown, a settings change.
- **Closures that read "current" UI state late** instead of capturing it: the
  HUD (`packages/shell/qml/services/Ghostd.qml`), the phone viewer
  (`packages/daemon/src/remote-viewer.ts`), `ghost say`.
- **State set by one event and cleared only by another** that some path never
  sends: tool cards (`harness-table.ts`; the fixture test holds every harness
  to "every tool that starts ends"), `settling`, `detached`, queued
  follow-ups, the countdown (`continuesAt`), handed-back composer text.
- **QML size bindings that depend on themselves** (implicit sizes, padding,
  wrapping, ListView contentHeight). One froze the owner's desktop shell at
  15 GB on 2026-10-07. A loop like that only runs while frames render, and
  the nested preview window often gets none, so a quiet preview proves
  little: look for "Binding loop" warnings in its log.

## Already settled: do not re-raise

Each was judged deliberately. Re-raising one wastes a round.

- Dropping `export` from names used only in their own file (no lines saved).
- `CharacterPane.draftText`; `RELAY_OPS` (test seams).
- Esc and "Esc to stop" while a stop hook decides: the owner wants a stop
  hook out of sight, the turn reading as finished.
- A next-work countdown or cancel in the phone viewer (an owner feature call).
- `HookConfig.js` `BUILTIN_DEFAULTS` mirroring the daemon's defaults.
- The turn stream log kept 60 s after a turn ends (against a lost-tail race).
- Detached turns not attaching to the live stream (the reload path is kept).
- MarkdownSegments re-parsing a long streamed block, and Bubble rebuilding
  tool cards per update (performance, deferred by the owner).
- The relay pairing poll every 3 s while the HUD is open.
- The previous ghost's idle conversation state kept on a ghost switch.
- `runAdmitted`'s unreachable `failure ||` in the continuation check.
- A `!command` scheduling no idle handoff (matches CONTRACTS.md).
- Phone-viewer live bubbles landing in a newly opened view until the turn
  ends.
- A HUD-streamed turn that ends while its conversation is not open keeping
  its state.
- A background job's `ghost say --follow-up` resetting `next_work_turns`. The
  owner wants long runs: the 100-turn cap is only a safety stop, and users
  change it on the Hooks page.
- The HUD reading "running" briefly after a `session_not_streaming` queue
  refusal; the viewer's busy message during an unannounced next-work turn;
  queue chips flickering after a busy send joins a turn or after stopping a
  detached turn (all cosmetic).

## Deploying to the live install

Only after `pnpm verify` passes and the push is done:

1. Wait until no conversation is running. Restarting ghostd ends every
   running turn: `ghost sessions | grep -q running` must be false.
2. In `~/src/ghost`: `git merge --ff-only origin/master && pnpm build`.
3. `systemctl --user restart ghostd.service`, then `ghost status` shows the
   new `daemon commit`.
4. `omarchy-restart-shell` for any QML change; confirm with `omarchy-shell
   shell debugBarGeometry` that the `ferdousbhai.ghost` widget loaded.

## Open with the owner

- The ActivityLine fix (`13e1ed28`) has not yet been proven live under the
  exact conditions that froze the shell (a long conversation open in the HUD
  while a turn streams). If omarchy-shell stalls again, read its log under
  `/run/user/$UID/quickshell/by-id/*/log.log` before it is killed.
