# Ghost

Your ghost, on your machine. An orchestration layer for all your AI agents. It
has its own character, reads the owner's documents, and runs locally as an
[Omarchy](https://omarchy.org)-native desktop app on the agent CLIs the owner
already has: each turn is a headless run of Claude Code, Codex, Grok, Copilot,
OpenCode, pi, or another harness Omarchy installs, on the owner's own
subscription and limits, falling through to the next harness with room.

Ghost brings what a harness does not: the persona, a conversation history that
survives switching harnesses, a browser relay into the owner's own Chromium,
computer use on the Omarchy desktop (`ghost-desktop`, an MCP server any client
can run), the ghost's MCP servers and skills, owner hooks, and scheduled work
through systemd timers. Its notes are Markdown in the owner's Documents
directory, shared by every ghost and the owner; nothing there is indexed or
injected. A ghost can also maintain the code it runs on
([docs/self-maintenance.md](docs/self-maintenance.md)), and the opt-in tailnet
viewer reaches it from a phone or any other device over Tailscale Serve.

The `ghost` terminal client talks only to ghostd's authenticated HTTP API and
has a named verb for everything the HUD can do:

```sh
ghost say "What should I focus on today?"
ghost sessions
ghost show -s cli-abc
ghost harnesses
ghost switch claude
```

Start with [docs/getting-started.md](docs/getting-started.md); the mental model
is [docs/concepts.md](docs/concepts.md) and the stable boundaries are
[CONTRACTS.md](CONTRACTS.md).

Status: [v0.5.1](https://github.com/ferdousbhai/ghost/releases/tag/v0.5.1) is
released. Ghost installs on Omarchy through the
[signed package installer](docs/getting-started.md); inclusion in Omarchy's
package repository and Install → AI menu is still in
[#54](https://github.com/ferdousbhai/ghost/issues/54).

License: Apache-2.0

An app can also bring its own UI: install `ghost-runtime` for the daemon/API,
CLI, and desktop/browser automation without the Ghost HUD. Setup is documented
in `packaging/arch/README.md` (`/usr/share/doc/ghost/ARCH.md` after installation).
