# `@ghost/omarchy`

Ghost's Omarchy desktop surfaces, as an omarchy-shell plugin
(`ferdousbhai.ghost`): the desktop presence, chat HUD, bar dot, settings and
context panes, and notifications. It runs inside the shell Omarchy already starts, so there is no
second Quickshell process, no unit, and no tray helper.

The manifest declares three kinds: `service` (the daemon connection, the
presence, and the notifications a shut window would swallow), `panel` (the
summon), and `bar-widget` (the ghost mark, in herdr's agent-state colours:
green outline idle, amber working, blue unread, red waiting on the owner).

`SUPER+CTRL+G` summons the presence: layer-shell surfaces glow along every
screen edge, a ring ignited from under the prompt (`EdgeGlow.js`), and a
prompt on the focused monitor takes the keyboard while Voxtype listens. After
a send, the glow thins and a ticker, then the reply card, stays up without
taking the keyboard until clicked; summoning again over it follows up in the
same conversation. Asked aloud, a ghost with a voice answers aloud (`Speech`,
through the owner's Piper; voices are picked in the Character pane). The
`Presence` singleton holds that state and `PresenceOverlay` (mounted by the
always-loaded service, since the host unloads the panel whenever it hides)
draws it.

The HUD (history, board, routines, character, ghosts, hooks, MCP, remote
access) opens from the bar dot, a notification, the card's `open`, or any
summon naming a section. It is drawn the way the desktop draws its own menu,
with the theme's `[menu]` tokens (`Theme.menu*`): a window titled `Ghost`,
transparent but for a scrim and the card, which Hyprland floats and pins at
the focused monitor's size by `DesktopKeys`' runtime rule (`ghost.conf`'s on a
`.conf` config; why it is a window is in `CONTRACTS.md`). It opens on the `Launcher`, a filter over conversations and
places at a fixed height on screen; Enter on a row grows the card into that view,
and Enter with nothing matching asks the ghost. Esc steps back (a standing
question, the workbench, the view, then out), as do the toggle and a scrim
click; a turn runs on behind it, and Shift+Esc stops one. Handing something
to another app (a link, a file, the external editor) closes it.

Every QML import here is a relative path. Inside the host, `qs.` resolves to
Omarchy's shell root, so `import qs.services` would bind these files to
Omarchy's modules instead of ours.

Installation and use: [getting started](../../docs/getting-started.md).
Integration samples: [contrib](contrib/README.md).
Preview and focused checks: [dev](dev/README.md).
Cross-package behavior: [CONTRACTS.md](../../CONTRACTS.md).

The `Ghostd` singleton serves HUD and bar state over authenticated HTTP/SSE.
Durable state changes use the daemon API; the workbench editor alone writes
ordinary files at the owner's direction. Preview those writes in isolation.

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
`monospace` rather than pinning a family. And `shell.toml` publishes no radius:
Omarchy's chrome rounds as Hyprland's windows do (`decoration:rounding`, read
with `hyprctl getoption`, again after each config reload), square by default,
so `Theme.radius` reads the same number and Ghost's cards, rows, dialogs and
chat bubbles match Omarchy's menu.

Lists follow the desktop menu's restraint: at rest a launcher row is its title
and a state mark (pin, unread, waiting, running); a row's detail appears while
filtering, to say why it matched, except state that always matters (a waiting
question, the loaded hooks count). Section labels align with the text they
head.

Because the face is monospace, horizontal measures are quoted in columns:
`Theme.ch(n)` resolves a character count through the real metrics of whatever
font fontconfig hands us, so a theme that raises `font.base-size` widens
reading columns and panels with it instead of clipping them.

Only the ghost's own identity is fixed: the amber presence and rose failure
colours, the spectral orb, and the code view, which stays dark in both Omarchy
modes because a syntax palette tuned for dark ink turns to mud on paper.

`OrbSeed.js` derives the phosphor orb's identity from the ghost's name and
animation from the turn. Keep those functions deterministic so redraws do not
change identity and fixtures remain reproducible.

## Verification

Never launch a plain development Quickshell process on the owner's session bus.
Use the isolated nested compositor:

```sh
# from packages/shell, in two terminals (see dev/README.md)
node dev/mock-ghostd.mjs --port 17719
bash dev/preview.sh qml 17719
```

Run lint and the QML suite with:

```sh
pnpm --filter @ghost/omarchy lint
pnpm --filter @ghost/omarchy test
```

The test harness maps daemon traffic to destination port 0 and uses private
imports/state, so it cannot contact the live service. Preview helpers capture
and stop only PIDs they start.
