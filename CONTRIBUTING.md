# Contributing

Ghost is maintained by its owners and by the ghosts that run on it. A ghost
reads this file from the clone its daemon runs from when it decides a change
is worth offering upstream; a human contributor follows the same steps.

## What belongs upstream

The ghost home under `~/ghosts/<name>/` is one owner's: character, notes,
hooks, settings, skills. Nothing there is a pull request.

`packages/`, `CONTRACTS.md`, and `docs/` are every ghost's. A change there that
does not encode one owner's preference is a candidate: a bug, contract drift
between doc and code, a runtime surface that one adapter has and the other
lacks, a policy line that turned out to be wrong in use. `docs/concepts.md`
lists what is deliberately absent; a PR that adds one of those needs the reason
the absence no longer holds.

## Once, by the owner

The PR is opened under the owner's GitHub identity, so the owner sets that up:

```sh
gh auth login
cd ~/src/ghost
gh repo fork --remote --remote-name fork
```

After this, `origin` is `ferdousbhai/ghost` and `fork` is the owner's copy.
An owner who can push to `ferdousbhai/ghost` itself skips the fork: topic
branches go to `origin`, and `fork` below reads `origin`.

## Every time

1. Start from current master, so the fix is against what upstream has and not
   against what the clone had when it was made:

   ```sh
   git fetch origin
   git switch -c <topic> origin/master
   ```

   Check `git log origin/master` and the open issues first. The bug may already
   be fixed or already filed.

2. Read `CLAUDE.md` and `CONTRACTS.md`. A change that crosses a package
   boundary or the wire changes `CONTRACTS.md` in the same commit, and a
   runtime-shaped change gets a decision for pi and for Claude Code both.

3. Edit, then run the touched package's tests and `typecheck`. Behavior
   changes ship with a focused test. Raising a ceiling in
   `packages/daemon/test/prompt-budget.test.ts` is justified in the commit
   message.

4. Commit with the reason in the message. If the committer is a ghost, say so
   in a trailer, with what it was running:

   ```
   Ghost: <name> on <pi|claude-code>, ghostd <version> <commit>
   ```

5. A ghost shows the owner the branch and asks before pushing. The push and
   the PR are outward-facing and carry the owner's name. Then:

   ```sh
   git push -u fork <topic>
   gh pr create --repo ferdousbhai/ghost --fill
   ```

   The PR body says what was wrong, what changed, and how it was verified,
   and it carries no owner detail from notes, transcripts, or the ghost home.

6. Adopt the change locally by the self-maintenance loop: `pnpm build` and a
   restart from the topic branch, or wait for it to land on master and
   rebase. The runbook is [docs/self-maintenance.md](docs/self-maintenance.md).

## Review

Maintainers review ghost PRs like any other. A PR whose reasoning is only in
a ghost's transcript is asked to put the reasoning in the description.
