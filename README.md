# Ghost

Your ghost, on your machine. An orchestration layer for all your AI agents, with
full access to your browser, terminal and apps. It has its own character, reads the
owner's documents, and runs locally as an [Omarchy](https://omarchy.org)-native
desktop app on the [pi](https://github.com/earendil-works/pi) coding agent.

A ghost keeps pi's native file tools, Bash, steering, and branchable
conversations, and adds owner questions (`ask`), a browser
relay into the owner's own Chromium, a computer-use sidecar for the Omarchy
desktop, MCP, skills, rules, and Markdown commands from its ghost home, model
roles with fallback chains, scheduled work through systemd timers, and context
windows in place of summarizing compaction. Its notes are Markdown in the
owner's Documents directory, shared by every ghost and the owner; nothing there
is indexed or injected. A ghost can also maintain the code it
runs on ([docs/self-maintenance.md](docs/self-maintenance.md)), and the opt-in
tailnet viewer reaches it from a phone or any other device over Tailscale Serve.

The `ghost` terminal client talks only to ghostd's authenticated HTTP API and
has a named verb for everything the HUD can do:

```sh
ghost say "What should I focus on today?"
ghost sessions
ghost show -s cli-abc
ghost login <provider>
```

Start with [docs/getting-started.md](docs/getting-started.md); the mental model
is [docs/concepts.md](docs/concepts.md) and the stable boundaries are
[CONTRACTS.md](CONTRACTS.md).

Status: beta release candidate, held until
[#17](https://github.com/ferdousbhai/ghost/issues/17) closes.

License: Apache-2.0
