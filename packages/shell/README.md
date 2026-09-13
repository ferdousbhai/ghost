# `@ghost/shell`

Ghost's Omarchy desktop surfaces, as an omarchy-shell plugin
(`ferdousbhai.ghost`): chat HUD, bar dot, settings and context panes, and
notifications. It runs inside the shell Omarchy already starts, so there is no
second Quickshell process, no unit, and no tray helper.

The manifest declares three kinds: `service` (the daemon connection and the
notifications a shut window would swallow), `panel` (the chat window), and
`bar-widget` (the state dot). The HUD is a normal `FloatingWindow`
(`xdg-toplevel`), so Hyprland owns tiling, focus, resizing, and workspace
movement; it finds its own window by title, because a plugin's window carries
the host shell's app-id. `SUPER+CTRL+G` is launch-or-focus, hiding only when
the focused HUD receives it again.

Every QML import here is a relative path. Inside the host, `qs.` resolves to
Omarchy's shell root, so `import qs.services` would bind these files to
Omarchy's modules instead of ours.

## Code map

```text
qml/manifest.json         plugin manifest: kinds and entry points
qml/Service.qml           service kind: daemon connection, toasts, IPC
qml/Panel.qml             panel kind: the host's open/close contract
qml/GhostHud.qml          chat window
qml/GhostBarWidget.qml    bar-widget kind: the state dot
qml/components/           chat, ask, jobs, queue, tools, routing, orb
qml/services/Ghostd.qml   authenticated HTTP/SSE client and UI state
contrib/                  Omarchy integration
dev/                      isolated preview, mock daemon, checks
```

Install integration lives in [`contrib/README.md`](contrib/README.md). Preview
and fixture options live in [`dev/README.md`](dev/README.md). Stable wire and
storage behavior lives in [`CONTRACTS.md`](../../CONTRACTS.md).

## UI boundaries

- One `Ghostd` singleton serves HUD and in-process bar state. It parses
  cumulative QML `XMLHttpRequest` SSE bodies directly; request objects remain
  strongly owned until terminal settlement.
- The shell edits durable state only through authenticated daemon routes. It
  never reads ghost homes or the owner's documents directly.
- `ask` replaces the composer while owner input is pending. It is not tool
  approval. Enter answers, Escape dismisses, and restored cards preserve how a
  question settled.
- While streaming, Enter steers, Ctrl+Enter queues a follow-up, and Shift+Enter
  inserts a newline.
- The work strip is background-job control only: bounded output, status, cancel,
  and visible-HUD polling while work runs. Plans and tasks live in the owner's
  documents; the shell has no plan mode or progress/todo projection.
- Tool activity is transient beside the orb. Settled replies keep failed calls
  and asks visible by default; the complete trace is available behind the steps
  disclosure, which the message reveals on hover along with its copy and edit
  controls. A turn that ran tools and said nothing keeps the count painted —
  there is no text to hover over, so it is the whole row.
- Context panels expose character, commands, hooks, resources, MCP, the bound
  model, remote access, and connection state.
- Dictation is Omarchy's Voxtype. The composer shows a toggle only while its
  state file exists, hands focus back to the field after toggling, and says
  when Voxtype is listening.

## Theme

Ghost is an Omarchy app and does not carry its own design system. Omarchy 4
publishes one, and `qml/services/Theme.qml` reads it out of the active theme
copy at `~/.local/state/omarchy/current/theme/`:

- `colors.toml` — the palette. `background` is the canvas, the same colour
  Omarchy gives its bar and popups; `dark_background` recesses a well or a
  rail and `lighter_background` raises a card. Dim text is walked from the
  theme's own foreground toward its background rather than taken from
  `dark_foreground`, which is a decorative key free to sit at any contrast.
- `shell.toml` — the rest of the system. `[font]` is a type scale rooted at
  one `base-size`; `[spacing]` is a token scale with an optional font-linked
  multiplier; `[controls]` is the four-state chrome ladder, one colour and one
  border varied by alpha; `[hyprland]` is the compositor's active border.
  Values may name another key (`border = "hyprland.active-border"`), and those
  references are followed. Every default matches
  `/usr/share/omarchy/default/themed/shell.toml.tpl`.

Two Omarchy decisions live outside those files. Its fontconfig binds
`monospace` to JetBrainsMono Nerd Font machine-wide, so the shell asks for
`monospace` rather than pinning a family. And `shell.toml` publishes no radius
while `default/hypr/looknfeel.lua` rounds nothing, so surfaces are square.

Because the face is monospace, horizontal measures are quoted in columns:
`Theme.ch(n)` resolves a character count through the real metrics of whatever
font fontconfig hands us, so a theme that raises `font.base-size` widens
reading columns and panels with it instead of clipping them.

Only the ghost's own identity is fixed: the amber presence and rose failure
colours, the spectral orb, and the code view, which stays dark in both Omarchy
modes because a syntax palette tuned for dark ink turns to mud on paper.

The orb is a phosphor matrix — square cells on a square grid, bright at the
core and falling off to the rim, with motes walking the outer ring one cell at
a time. It is made of the same stuff as the rest of the screen and stays the
one lit thing in it. No two summonings look alike: `OrbSeed.js` takes the
disc's falloff, its phosphor's place in the spectral band and its mote count
from the ghost's name, so a ghost looks like itself across every conversation,
and every cell's rhythm from the turn, so the same ghost never flickers the
same way twice. Both are pure functions of their seed, which is what makes an
orb testable and stops a redraw restyling it mid-turn.

## Verification

Never launch a plain development Quickshell process on the owner's session bus.
Use the isolated nested compositor:

```sh
packages/shell/dev/preview.sh
```

Run lint and the QML suite with:

```sh
pnpm --filter @ghost/shell lint
pnpm --filter @ghost/shell test
```

The test harness maps daemon traffic to destination port 0 and uses private
imports/state, so it cannot contact the live service. Preview helpers capture
and stop only PIDs they start.
