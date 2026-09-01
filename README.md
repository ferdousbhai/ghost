# Ghost

Your ghost, on your machine. An AI persona with private memory, shared Obsidian
knowledge, docs, and tools — running locally as an
[Omarchy](https://omarchy.org)-native desktop app,
built on the [pi](https://github.com/earendil-works/pi) coding agent
(`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`).

Ghost pins pi 0.84.3. pi sessions keep its native filesystem tools and Bash,
steering/follow-ups, and branchable conversations; Ghost adds its own `ask`
tool, supervised native Pi/Codex/Claude Code workers, model roles and fallback
chains, bounded declarative skills, rules,
Markdown commands/prompts, and MCP from the visible ghost home plus one
explicitly trusted project. Live voice remains deferred; remote sharing uses
the built-in tailnet viewer over Tailscale Serve, and no separate collaboration
relay is planned. Project plugins, agent definitions, custom code tools, and
LSP remain disabled in principal sessions pending a per-session isolation
boundary; trusted visible `hooks/pre` and `hooks/post` files in the ghost home
remain the explicit in-process extension surface. Native delegated workers and
the optional Claude Code principal retain their own project discovery and
subagents. Ghost replaces
pi's coding-oriented system prompt with its character and bounded private
memory index, plus the owner-installed `obsidian-cli` skill through normal
machine-skill discovery. Both runtimes use Obsidian's CLI-selected vault as
owner-visible persistent state shared by every ghost; they never infer that the
vault is `~/Documents` or access it as raw files. Claude keeps its native preset
and receives the same Ghost-owned context as an append. Browser and desktop
capabilities remain available. The Quickshell client renders live tool activity
beside the recovered summoning orb from the earlier summon-ghost interface,
naming the call the ghost is inside of while it runs.

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
ghost delegation
```

Status: beta release candidate. See CONTRACTS.md for the data and API
contracts, and [docs/hooks.md](docs/hooks.md) for awaited model-harness hooks.

License: Apache-2.0
