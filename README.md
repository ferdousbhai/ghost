# Ghost

> **Resumed on 2026-11-24 with a narrower aim.** See
> [docs/status.md](docs/status.md).

**Your own data and your ghost, answered by a model on your machine.** Ghost
runs locally on [Omarchy](https://omarchy.org). Its window shows your notes,
reminders, mail, chats, files and photos, read through the products that
already hold them, and a persona answers from them. Every turn runs on a
local model, so none of it leaves the computer.

Talk to it in its window or the terminal; both share one conversation
history, and `ghost say` joins the most recent conversation:

```sh
ghost say "What should I focus on today?"
ghost say "Continue that thought."
```

The model has one tool, a shell. For work on code it runs the coding agent
you already use (Claude Code, Codex, Antigravity) by that agent's own command.
Notes are Markdown in the owner's Documents directory, never indexed or
injected. A ghost can maintain its own code
([docs/self-maintenance.md](docs/self-maintenance.md)), and the
[summonghost.com](https://summonghost.com) app ([`packages/web`](packages/web/README.md)) reaches it from a phone over an
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
