# Concepts

Ghost gives the owner a persistent persona and one conversation history. The
daemon owns that
state; the window and terminal are clients of the same authenticated API.
[Getting started](getting-started.md) covers use;
[CONTRACTS.md](../CONTRACTS.md) defines storage, wire, and lifecycle guarantees.

## Why a local model answers

A ghost answers from the owner's notes, mail, chats, files and photos. A
model on the owner's machine keeps all of that there, so it is the only thing
a turn runs on; Ghost has no cloud model, provider, or sign-in of its own.

The model's loop is the smallest that works: the persona, two tools (a shell
that runs as the owner, and `ask`, a question to the owner with the ways
forward as answers), and no cap on rounds. The owner's products are
command lines with a skill each, so the shell reaches all of them. Work on
code goes to the coding agent the owner already uses, run by its own command
from that shell: the agent keeps its model, credentials, tools and
permissions, and what the model hands it is the one thing that leaves the
machine.

## Why files own durable context

A ghost home keeps its character, conversations, and configuration together
in one directory the owner can move or trash. Notes and plans live in the `Notes`
folder of the owner's Documents directory, shared by the owner and the ghost,
and the owner's to-do list as checklists in its `Reminders` folder: Markdown editable with ordinary
file tools, and synced by iCloud only if you connect it. Ghost names that
directory in the prompt but neither indexes it nor injects its contents; a
ghost searches it when a task needs it. Recall, an optional separate product,
can index chosen folders, but its hits only point at the source files, which
stay authoritative.

A conversation has its own working directory. A coding agent run in
a project's directory discovers that project's instructions normally.
Ghost adds no trusted-project registry, private memory database, plan mode,
or todo API.

## Why existing machine facilities own the rest

- The window follows Omarchy's current theme through omui. Ghost has no
  shell plugin, bar widget, or tray helper.
- Browser automation uses the installed agent-browser CLI through Bash in
  the owner's signed-in Chromium, with separate tabs for concurrent tasks.
- There is no screen control. Desktop work goes through Omarchy's commands,
  app CLIs, and config files; what none of them reach, the ghost says so.
- Dictation is Omarchy's, typing into Ghost as into any app. Ghost adds no speech stack.
- Background work is a shell command. Ghost has no scheduler, job table, or
  worker manager.
- Hooks are explicit owner commands. Ghost starts no automatic handoff or
  next-work turns and has no built-in review or training loop.
- Omarchy owns package updates. Git, journald, systemd, and Trash provide code
  history, diagnostics, restart, and recovery; Ghost duplicates none of them.

## Adding behavior

First consider an installed CLI and its skill, or an owner hook. A new Ghost surface needs a demonstrated constraint those cannot
meet and must say what it replaces. Dependencies cost installed bytes as well
as code.

See [hooks](hooks.md), [self-maintenance](self-maintenance.md),
[contributing](../CONTRIBUTING.md), and
[release packaging](../packaging/release/README.md) for the respective workflows.
Unfinished work belongs in GitHub issues; historical plans remain in Git.
