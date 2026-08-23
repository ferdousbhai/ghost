# Ghost

Your ghost, on your machine. An AI persona with memory, notes, and tools —
running locally as an [Omarchy](https://omarchy.org)-native desktop app,
built on the modern [Oh My Pi](https://github.com/can1357/oh-my-pi)
agent harness.

Ghost pins OMP 18.0.3. Its local harness supplies the native `ask` tool,
mid-turn steering and follow-ups, provider fallback chains and role routing,
and branchable conversations. Ghost keeps coding/filesystem built-ins and tool
approval UI disabled; a ghost receives only `ask` plus its scoped extension
tools. The Quickshell client renders live tool activity and the recovered
summoning orb from the earlier summon-ghost interface.

Status: early construction. See CONTRACTS.md for the data and API contracts,
and [docs/hooks.md](docs/hooks.md) for awaited model-harness hooks.

License: Apache-2.0
