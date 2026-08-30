# Ghost

Your ghost, on your machine. An AI persona with memory, docs, and tools —
running locally as an [Omarchy](https://omarchy.org)-native desktop app,
implemented with the [pi](https://github.com/earendil-works/pi) agent runtime
(`@earendil-works/pi-coding-agent`, `pi-agent-core`, `pi-ai`).

Ghost pins pi 0.84.3. Pi sessions keep its native filesystem tools,
steering/follow-ups, and branchable conversations; Ghost adds job-aware Bash,
its own `ask` tool, model roles and fallback chains, bounded declarative skills,
rules, Markdown commands/prompts, and MCP from the visible ghost home plus one
explicitly trusted project. Live voice remains deferred; remote sharing uses
the built-in tailnet viewer over Tailscale Serve, and no separate collaboration
relay is planned. Project plugins, hooks, custom code tools,
and LSP stay disabled inside a Ghost principal session; the bundled
`pi-worker` may run trusted project extensions and hooks in its isolated task
child after the owner binds the project, while model-callable custom tools stay
outside its fixed bundled tool set. Trusted visible `hooks/pre` and `hooks/post`
files in the ghost home remain the explicit in-process extension surface. The
native `codex` and `claude-code` workers use the owner's installed harnesses and
native user/project configuration; see
[docs/native-workers.md](docs/native-workers.md).
Both principal runtimes expose Ghost's durable `task` controls for those three
built-in workers; custom agent definitions remain inert. A Claude principal
disables Claude's native Agent/legacy Task shortcuts so delegation cannot
bypass that lifecycle, while a delegated Claude worker retains native
subagents. Clean Git tasks run in one linked worktree and local review branch;
Ghost never pushes, opens a pull request, or merges without a separate explicit
owner action. Ghost replaces pi's coding-oriented system prompt with its
character, bounded memory, shallow owner Documents indexes, and minimal runtime
guidance. Claude receives the same complete Ghost-owned identity as a custom
prompt while keeping its native tool preset. Browser and desktop capabilities
remain available. The Quickshell client renders
live tool activity and the recovered summoning orb from the earlier
summon-ghost interface.

Idle maintenance may write owner-grounded memory and consolidates it only under
index pressure; every memory write redacts common credential forms before disk.
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
