# Ghost

Your ghost, on your machine. An AI persona with memory, docs, and tools —
running locally as an [Omarchy](https://omarchy.org)-native desktop app,
built on the modern [Oh My Pi](https://github.com/can1357/oh-my-pi)
agent harness.

Ghost pins OMP 18.0.3. Pi sessions keep its native filesystem, Bash, web search,
hub coordination, background jobs, steering/follow-ups, fallback routing, and
branchable conversations. Ghost adds bounded declarative skills, rules,
Markdown commands/prompts, and MCP from the visible ghost home plus one
explicitly trusted project. Pi's `task` tool and every subagent definition are
disabled in phase 1; project plugins, hooks, custom code tools, and LSP are also
disabled pending a per-session isolation boundary. Trusted visible
`hooks/pre` and `hooks/post` files in the ghost home remain the explicit
in-process extension surface. The optional Claude Code runtime retains Claude's
native subagents. Ghost replaces Pi's coding-oriented system prompt with its
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

Status: beta release candidate. See CONTRACTS.md for the data and API
contracts, and [docs/hooks.md](docs/hooks.md) for awaited model-harness hooks.

License: Apache-2.0
