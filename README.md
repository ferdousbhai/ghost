# Ghost

> **Frozen on 2026-11-20.** No feature work and no releases: official Omarchy 4.5
> now ships most of what Ghost did. See [docs/status.md](docs/status.md).

**An orchestration layer for all your agent harnesses.** Ghost runs locally
on [Omarchy](https://omarchy.org), coordinating Claude Code, Codex, Grok,
Copilot, OpenCode, pi, and other installed agent CLIs. Each harness keeps
its own sign-in, tools, and limits. If one cannot take a turn, Ghost tries
the next. Your ghost keeps one character and conversation history across them.

Talk to it in its window or the terminal; both share one conversation
history, and `ghost say` joins the most recent conversation:

```sh
ghost say "What should I focus on today?"
ghost switch claude
ghost say "Continue that thought."
```

What Ghost adds to a harness: the persona, a history that survives switching
agents, browser automation through agent-browser and Bash, and owner hooks.
Notes are Markdown in the owner's Documents directory, never indexed or
injected. A ghost can maintain its own code
([docs/self-maintenance.md](docs/self-maintenance.md)), and the
[summonghost.com](https://summonghost.com) app reaches it from a phone over an
opt-in Tailscale Serve address.

Install and first conversation:
[getting started](https://github.com/ferdousbhai/ghost/blob/master/docs/getting-started.md)
(ten minutes). The mental model is
[concepts](https://github.com/ferdousbhai/ghost/blob/master/docs/concepts.md);
the stable boundaries are [CONTRACTS.md](CONTRACTS.md).

Install from Omarchy's package repository with `omarchy pkg add ghost`, then
start it for this login ([getting started](docs/getting-started.md#3-confirm-setup)).
The Install → AI menu entry, which does both, is tracked in
[#54](https://github.com/ferdousbhai/ghost/issues/54).

License: Apache-2.0
