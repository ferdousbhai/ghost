# Concepts

Ghost gives the owner's installed agent CLIs a persistent persona, shared
conversation history, and an Omarchy desktop interface. The daemon owns that
state; the HUD and terminal are clients of the same authenticated API.
[Getting started](getting-started.md) covers use;
[CONTRACTS.md](../CONTRACTS.md) defines storage, wire, and lifecycle guarantees.

## Why harnesses own execution

Each harness already owns its model, credentials, tools, permissions, retries,
and compaction. Running it directly avoids a second implementation inside
Ghost. A harness adapter is launch flags and an output parser.

Ghost preserves history across harness changes. It can try another installed
harness when one fails before producing text or starting a tool; afterward it
ends the turn with the error, avoiding replay of possible side effects.
Usage reports are informational, never admission gates. Ghost adds no provider,
spend, or concurrency caps; desktop actions alone need a lease because there
is one pointer and focus.

## Why files own durable context

A ghost home keeps its character, conversations, and configuration together
for recoverable rename and deletion. Notes, plans, and tasks live in the
owner's Documents directory, shared by all ghosts and editable with ordinary
file tools. Ghost names that directory in the prompt but neither indexes it
nor injects its contents. The board renders `board.md` read-only.

A conversation has its own working directory. A delegated harness run can
use a project's directory and discover that project's instructions normally.
Ghost adds no trusted-project registry, private memory database, plan mode,
or todo API.

## Why existing machine facilities own the rest

- The HUD is an omarchy-shell plugin, sharing the desktop's theme and lifecycle.
  Ghost has no second shell process or tray helper.
- Browser automation uses the opt-in relay in the owner's visible Chromium
  session. It has no hidden browser or second backend.
- Computer use is the separate `ghost-desktop` MCP server. Prefer a CLI or
  browser action when available; desktop input can disturb the owner's focus.
- Dictation uses Omarchy's Voxtype. Ghost adds no speech stack.
- Scheduled work uses systemd timers; background work is a shell command.
  Ghost has no job table or worker manager.
- Hooks are explicit owner commands. Ghost starts no automatic handoff or
  next-work turns and has no built-in review or training loop.
- Omarchy owns package updates. Git, journald, systemd, and Trash provide code
  history, diagnostics, restart, and recovery; Ghost duplicates none of them.

## Adding behavior

First consider an installed CLI and its skill, an owner hook, or a harness
feature. A new Ghost surface needs a demonstrated constraint those cannot
meet and must say what it replaces. Dependencies cost installed bytes as well
as code. Delegation receipts record process outcomes, not task quality; they
are no evidence by themselves that an automatic selector would improve work.

See [hooks](hooks.md), [self-maintenance](self-maintenance.md),
[contributing](../CONTRIBUTING.md), and
[release packaging](../packaging/release/README.md) for the respective workflows.
Unfinished work belongs in GitHub issues; historical plans remain in Git.
