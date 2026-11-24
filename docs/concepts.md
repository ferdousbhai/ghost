# Concepts

Ghost gives the owner's installed agent CLIs a persistent persona, shared
conversation history, and a window on the owner's own data. The daemon owns that
state; the window and terminal are clients of the same authenticated API.
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
spend, or concurrency caps.

## Why files own durable context

A ghost home keeps its character, conversations, and configuration together
in one directory the owner can move or trash. Notes and plans live in the `Notes`
folder of the owner's Documents directory, and tasks as checklists in its
`Reminders` folder: Markdown editable with ordinary
file tools, and synced by iCloud only if you connect it. Ghost names that
directory in the prompt but neither indexes it nor injects its contents; a
ghost searches it when a task needs it. Recall, an optional separate product,
can index chosen folders, but its hits only point at the source files, which
stay authoritative.

A conversation has its own working directory. A delegated harness run can
use a project's directory and discover that project's instructions normally.
Ghost adds no trusted-project registry, private memory database, plan mode,
or todo API.

## Why existing machine facilities own the rest

- The window follows Omarchy's current theme through omui. Ghost has no
  shell plugin, bar widget, or tray helper.
- Browser automation uses the installed agent-browser CLI through Bash in
  the owner's signed-in Chromium, with separate tabs for concurrent tasks.
- There is no screen control. Desktop work goes through Omarchy's commands,
  app CLIs, and config files; what none of them reach, the ghost says so.
- Dictation uses Omarchy's Voxtype. Ghost adds no speech stack.
- Background work is a shell command. Ghost has no scheduler, job table, or
  worker manager.
- Hooks are explicit owner commands. Ghost starts no automatic handoff or
  next-work turns and has no built-in review or training loop.
- Omarchy owns package updates. Git, journald, systemd, and Trash provide code
  history, diagnostics, restart, and recovery; Ghost duplicates none of them.

## Adding behavior

First consider an installed CLI and its skill, an owner hook, or a harness
feature. A new Ghost surface needs a demonstrated constraint those cannot
meet and must say what it replaces. Dependencies cost installed bytes as well
as code.

See [hooks](hooks.md), [self-maintenance](self-maintenance.md),
[contributing](../CONTRIBUTING.md), and
[release packaging](../packaging/release/README.md) for the respective workflows.
Unfinished work belongs in GitHub issues; historical plans remain in Git.
