# Ghost

**Your ghost, on your machine.** A local assistant with its own character,
running on [Omarchy](https://omarchy.org) through the agent CLIs you already
use: each turn is a run of Claude Code, Codex, Grok, Copilot, OpenCode, pi, or
another installed harness, on that agent's own sign-in and limits. If one
cannot take a turn, Ghost tries the next.

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

Status: [v0.6.0](https://github.com/ferdousbhai/ghost/releases/tag/v0.6.0) is
released and installs on Omarchy through the signed package installer;
inclusion in Omarchy's package repository and Install → AI menu is tracked in
[#54](https://github.com/ferdousbhai/ghost/issues/54).

An app can bring its own UI: `ghost-runtime` installs the daemon/API, CLI, and
desktop/browser automation without the HUD (`packaging/arch/README.md`,
`/usr/share/doc/ghost/ARCH.md` once installed).

License: Apache-2.0
