# Contributing

Read [AGENTS.md](AGENTS.md) for working rules and [CONTRACTS.md](CONTRACTS.md)
for shared guarantees. Check current issues and commits before starting.

Owner-specific character, documents, configuration, and transcripts stay
private. Upstream fixes must generalise without including owner data.
[Concepts](docs/concepts.md) explains the product's deliberate boundaries.

## Workflow

Follow the owner's authorized workflow. Work in this repository currently
commits directly to `master`; do not open task PRs. External contributors use
a topic branch and a fork. A ghost needs owner authorization to publish under
their GitHub identity; an existing instruction to push is sufficient.

1. Preserve concurrent edits. Never stash, restore, or discard a peer's work.
2. Update contracts and all affected consumers together. Add a focused test
   for behavior changes; run the affected tests and package typecheck.
3. Commit the problem, change, and reason. Justify any prompt-budget increase
   in the message. A ghost-authored change can identify its harness in a trailer.
4. Push only within the authorized scope. Master pushes require the full
   `pnpm verify` gate after the final commit; never bypass the hook.
5. If using a PR, describe the resulting behavior and validation, then remove
   its worktree and branches after merge.

A source build does not update a packaged install. Deploy and verify using
[the maintenance runbook](docs/self-maintenance.md), with runtime and HUD from
one version. Test changes against scratch state and the isolated HUD preview,
never the owner's live ghost or desktop.
