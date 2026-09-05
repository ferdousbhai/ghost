# Ghost

Your ghost, on your machine. An AI persona with a character, the owner's own
documents, and tools — running locally as an
[Omarchy](https://omarchy.org)-native desktop app,
built on the [pi](https://github.com/earendil-works/pi) coding agent
(`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`).

Ghost pins pi 0.84.3. pi sessions keep its native filesystem tools and Bash,
steering/follow-ups, and branchable conversations; Ghost adds an `ask` tool
matching Claude Code's native `AskUserQuestion`, supervised native
Pi/Codex/Claude Code workers, model roles and fallback
chains, bounded declarative skills, rules,
Markdown commands/prompts, and MCP from the visible ghost home. Remote sharing
uses the built-in tailnet viewer over Tailscale Serve. Plugins, agent
definitions, custom code tools, and LSP remain disabled in principal sessions;
trusted visible `hooks/pre` and `hooks/post` files in the ghost home remain the
explicit in-process extension surface. The optional Claude Code principal
retains its own subagents. Ghost replaces
pi's coding-oriented system prompt with its character. Both runtimes treat the owner's XDG Documents directory as the
persistent owner-visible state every ghost shares, reading and writing it with
their native file tools.
Nothing in it is indexed or injected at session start. Claude keeps its complete,
unfiltered native tool preset and receives the same Ghost-owned context as an
append; Ghost tools are added only for capabilities that preset lacks. Browser
and desktop capabilities remain available. A ghost can also maintain the code it
runs on: it edits the clone named by `self.checkout`, builds it, and hands the
restart to systemd, as in
[docs/self-maintenance.md](docs/self-maintenance.md). The Quickshell client renders live
tool activity beside the recovered summoning orb from the earlier summon-ghost
interface, naming the call the ghost is inside of while it runs.

A ghost keeps its notes as Markdown in the owner's documents, shared by every
ghost and the owner, and writes them with its file tools. Provider logins live
in pi's own credential file under the ghost home.

The `ghost` terminal client talks only to ghostd's authenticated HTTP API. Use
it for a quick terminal conversation or to inspect the same sessions the HUD
shows.

```sh
ghost say "What should I focus on today?"
ghost sessions
ghost show -s cli-abc
ghost login <provider>
```

Status: beta release candidate. See CONTRACTS.md for the data and API
contracts, and [docs/hooks.md](docs/hooks.md) for awaited model-harness hooks.

License: Apache-2.0
