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
agents, a browser relay into the owner's Chromium, computer use on the
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
