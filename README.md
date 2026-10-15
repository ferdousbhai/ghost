# Ghost

**An orchestration layer for all your agent harnesses.** Ghost runs locally
on [Omarchy](https://omarchy.org), coordinating Claude Code, Codex, Grok,
Copilot, OpenCode, pi, and other installed agent CLIs. Each harness keeps
its own sign-in, tools, and limits. If one cannot take a turn, Ghost tries
the next. Each ghost has its own character and conversation history.

Talk to it in the desktop HUD or the terminal; both share one conversation
history, and `ghost say` joins the most recent conversation:

```sh
ghost say "What should I focus on today?"
ghost switch claude
ghost say "Continue that thought."
```

What Ghost adds to a harness: the persona, a history that survives switching
agents, browser automation through agent-browser and Bash, computer use on the
desktop (`ghost-desktop`, an MCP server any client can run), the ghost's MCP
servers and skills, owner hooks, and scheduled work through systemd timers.
Notes are Markdown in the owner's Documents directory, never indexed or
injected. A ghost can maintain its own code
([docs/self-maintenance.md](docs/self-maintenance.md)), and an opt-in tailnet
viewer reaches it from a phone.

Install and first conversation:
[getting started](https://github.com/ferdousbhai/ghost/blob/master/docs/getting-started.md)
(ten minutes). The mental model is
[concepts](https://github.com/ferdousbhai/ghost/blob/master/docs/concepts.md);
the stable boundaries are [CONTRACTS.md](CONTRACTS.md).

Install from Omarchy's package repository with `omarchy pkg add ghost`, or
use `curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash` to install
and configure the daemon and desktop plugin. The Install → AI menu entry
is tracked in [#54](https://github.com/ferdousbhai/ghost/issues/54).

An app can bring its own UI: `ghost-runtime` installs the daemon/API, CLI, and
desktop/browser automation without the HUD (`packaging/arch/README.md`,
`/usr/share/doc/ghost/ARCH.md` once installed).

License: Apache-2.0

## Optional Recall search

Use `ghost sessions --semantic QUERY` to rank the current ghost’s conversation titles and previews. Transcripts and notes are not indexed by this command.

Recall is an optional extra. Normal operation never contacts it. Missing, incompatible, busy, or warming-up Recall leaves title/preview text matching available. Requests run in the background with a bounded wait. This project does not install Recall, download embedding weights, or start its own model runtime. When enabled, the owner-local Recall service owns one shared model cache and inference worker; records stay on this machine.
