# Ghost

Your ghost, on your machine. An AI persona with memory, docs, and tools —
running locally as an [Omarchy](https://omarchy.org)-native desktop app,
built on the [pi](https://github.com/earendil-works/pi) coding agent
(`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`).

Ghost pins pi 0.84.3. pi sessions keep its native filesystem tools and Bash,
steering/follow-ups, and branchable conversations; Ghost adds its own `ask`
tool, model roles and fallback chains, bounded declarative skills, rules,
Markdown commands/prompts, and MCP from the visible ghost home plus one
explicitly trusted project. Live voice remains deferred; remote sharing uses
the built-in tailnet viewer over Tailscale Serve, and no separate collaboration
relay is planned. The principal Ghost can delegate coding through five durable
task tools to native Pi, Codex, or Claude Code workers. The principal does not
execute project or ghost-file subagent definitions; delegated workers retain
their harness's native project discovery, and Claude may receive one optional
opaque native agent name. Principal project
plugins, hooks, custom code tools, and LSP are also disabled pending a
separate isolation boundary. Trusted visible `hooks/pre` and `hooks/post`
files in the ghost home remain the explicit in-process extension surface. The
optional Claude Code runtime retains Claude's native subagents. Ghost replaces
pi's coding-oriented system prompt with its
character, bounded memory and shallow owner Documents indexes, and minimal
runtime guidance; Claude keeps its native preset and receives the same
Ghost-owned context as an append. Browser and desktop capabilities remain
available. The Quickshell client renders
live tool activity and the recovered summoning orb from the earlier
summon-ghost interface.

Idle maintenance may write owner-grounded memory and consolidates it only under
index pressure; every memory write redacts common credential forms before disk.
Provider and MCP secrets live in Linux Secret Service, while portable config
holds only keyring references; see [docs/keyring.md](docs/keyring.md).

The `ghost` terminal client normally talks to ghostd's authenticated HTTP API.
Its one local read-only exception, `ghost delegation`, reports installed native
coding-worker availability without opening ghost data. Use the API-backed
commands for a quick terminal conversation or to inspect the same sessions the
HUD shows.

```sh
ghost say "What should I focus on today?"
ghost sessions
ghost show -s cli-abc
ghost delegation
```

Status: beta release candidate. See CONTRACTS.md for the data and API
contracts, and [docs/hooks.md](docs/hooks.md) for awaited model-harness hooks.

License: Apache-2.0
