---
name: ghost
description: The `ghost` CLI, for a ghost and for any agent working with Ghost on this machine. Use before running an agent in another project, starting work that must outlive the turn, scheduling work, answering an external event, notifications, peers, hooks or MCP servers, a hot or struggling machine, crashes, tidying notes, or editing, restarting or updating Ghost itself.
---

# Ghost

`ghost` talks to ghostd, the daemon that runs this machine's ghosts.
`ghost --help` lists every command; `ghost help <command>` explains one.
`ghost help <topic>` prints a recipe rendered for this machine and ghost:
read it before acting on that topic. `ghost status` says whether the daemon
runs from the package or a checkout, and whether it needs a restart.

| Before you | Read |
| --- | --- |
| run an agent in another project, which a ghost's turn cannot load | `ghost help harnesses` |
| start work that must outlive this turn | `ghost help background` |
| schedule clock work | `ghost help timers` |
| handle an external event | `ghost help events` |
| tell the owner something when they are away | `ghost help notifications` |
| add, remove or message a peer | `ghost help peers` |
| act on heat, fans, memory or a full disk | `ghost help machine` |
| act on a crash or a failed service | `ghost help crashes` |
| look up, keep or tidy notes | `ghost help memory` |
| transcribe audio | `ghost help dictation` |
| edit, restart or update Ghost | `ghost help self` |

## Rules a recipe will not repeat

- A ghost's turns run in its conversation's directory: a project's own
  instructions, settings and MCP servers load only in an agent run there
  (`cd <dir> && ghost delegate <harness> -- <args>`).
- Work that must outlive the turn runs detached and ends with
  `ghost say --follow-up`; a harness's own background jobs end with the turn.
- Ghost has no scheduler: clock work is a systemd user timer, and timers fire
  only while the owner is logged in, so promise no check-ins while they are
  away.
- Add or remove a peer only when the owner asks. `ghost peers list` names
  them; `ghost message <peer> "<text>"` writes to one.
- From a packaged install Ghost cannot write its own code: run from your own
  clone first, as `ghost help self` says. A restart aborts every running
  turn, so finish the turn and tell the owner before one.
- Hooks: `ghost hooks`; MCP servers: `ghost mcp`; the board:
  `ghost board`.
