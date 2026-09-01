# Ghost

Your ghost, on your machine. An AI persona with private memory, shared Obsidian
knowledge, docs, and tools — running locally as an
[Omarchy](https://omarchy.org)-native desktop app,
built on the [pi](https://github.com/earendil-works/pi) coding agent
(`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`).

Ghost pins pi 0.84.3. pi sessions keep its native filesystem tools and Bash,
steering/follow-ups, and branchable conversations; Ghost adds its own `ask`
tool, model roles and fallback chains, bounded declarative skills, rules,
Markdown commands/prompts, and MCP from the visible ghost home plus one
explicitly trusted project. Live voice remains deferred; remote sharing uses
the built-in tailnet viewer over Tailscale Serve, and no separate collaboration
relay is planned. There is no `task` tool and every subagent definition is
disabled in phase 1; project
plugins, hooks, custom code tools, and LSP are also disabled pending a
per-session isolation boundary. Trusted visible `hooks/pre` and `hooks/post`
files in the ghost home remain the explicit in-process extension surface. The
optional Claude Code runtime retains Claude's native subagents. Ghost replaces
pi's coding-oriented system prompt with its character, bounded memory and
shallow owner Documents indexes, plus an explicit link to the owner-installed
`obsidian-cli` skill. Both runtimes use Obsidian's CLI-selected vault as
owner-visible persistent state shared by every ghost; they never infer that the
vault is `~/Documents` or access it as raw files. Claude keeps its native preset
and receives the same Ghost-owned context as an append. Browser and desktop
capabilities remain available. The Quickshell client renders live tool activity
and the recovered summoning orb from the earlier summon-ghost interface.

Idle maintenance may write one ghost-private reflection and consolidates memory
only under index pressure; shared knowledge goes through Obsidian instead. Every
memory write redacts common credential forms before disk.
Provider and MCP secrets live in Linux Secret Service, while portable config
holds only keyring references; see [docs/keyring.md](docs/keyring.md).

The `ghost` terminal client talks only to ghostd's authenticated HTTP API. Use
it for a quick terminal conversation or to inspect the same sessions the HUD
shows.

```sh
ghost say "What should I focus on today?"
ghost sessions
ghost show -s cli-abc
```

Status: beta release candidate. See CONTRACTS.md for the data and API
contracts, and [docs/hooks.md](docs/hooks.md) for awaited model-harness hooks.

License: Apache-2.0
