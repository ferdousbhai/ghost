# `@ghost/omarchy`

Ghost's Omarchy desktop surfaces, as an omarchy-shell plugin
(`ferdousbhai.ghost`): the desktop presence, chat HUD, bar dot, settings and
context panes, and notifications. It runs inside the shell Omarchy already starts, so there is no
second Quickshell process, no unit, and no tray helper.

The manifest declares three kinds: `service` (the daemon connection, the
presence, and the notifications a shut window would swallow), `panel` (the
summon), and `bar-widget` (the ghost mark). What other packages and the
owner's configuration rely on (the summon payload, the `ghost` IPC, what it
asks of Hyprland, notifications) is in [CONTRACTS.md](../../CONTRACTS.md);
how it behaves is here.

## How it behaves

**The presence.** `SUPER+CTRL+G`, or a summon with nothing named, opens it: a
prompt on the focused monitor takes the keyboard, already listening if
Voxtype is installed, and every screen's edges glow. Enter sends; Enter on an
empty prompt while recording stops it and sends the transcript once Voxtype
has typed it; Tab picks another ghost; Esc, a click outside, or SUPER+W
dismisses it. Sending starts a new conversation, or continues the presence's
while its ticker or reply card is up, unless the owner chose `new ×`. The
prompt then closes, the glow thins to a shimmer, and a ticker that takes no
keyboard unclicked shows the turn's activity, then its reply or error as a
card, until dismissed or opened in the HUD. The `Presence` singleton holds
that state and `PresenceOverlay` (mounted by the always-loaded service, since
the host unloads the panel whenever it hides) draws it.

**The glow** is one ring of colour flowing round the screen (`EdgeGlow.js`),
drawn by four edge surfaces that take no input and reserve no space. A summon
ignites it from where it came from (under the prompt, the bar mark that was
clicked, else the top edge): bright heads race outward both ways until they
meet opposite. While Ghost is the foreground app (the prompt or the HUD has
the keyboard) the ring flows and breathes, the HUD's a softer one on its own
screen; behind another app it goes out. Reduced motion keeps the colour and
drops the sweep and the breathing.

**The HUD** (history, board, routines, character, ghosts, hooks, MCP, remote
access) opens from the bar mark, a notification, the card's `open`, or any
summon naming a section, drawn the way the desktop draws its own menu, with
the theme's `[menu]` tokens (`Theme.menu*`). It and the prompt are windows,
not layers, which `DesktopKeys`' rule floats and pins at their monitor's size
without decoration: as the focused window SUPER+W closes Ghost, never the app
behind it, while every other binding (screenshots, volume, workspaces) keeps
working, and a compositor close is a dismissal. It opens on the `Launcher`, a
filter over conversations and places at a fixed height on screen: pinned
conversations first, then those holding an open question, then unread
replies, then the rest, newest first. Enter on a row grows the card into that
view, and Enter with nothing matching asks the ghost. Opened on its list, it
listens as the prompt does: Voxtype types into the filter, Enter while
listening asks the ghost what was said, and arrowing to a row or leaving the
list stops it; a restore after a reload neither listens nor ignites. Esc
steps back (a standing question, the workbench, the view, then out), as do
the toggle and a scrim click; a turn runs on behind it, and Shift+Esc stops
one. Handing something to another app (a link, a file, the external editor)
closes it. A workbench conflict or failed save blocks closing, switching
files, and the external editor until it is resolved.

**The bar mark** is the ghost glyph in herdr's agent states over every
conversation of the selected ghost, most urgent first: filled red while one
holds an open question, filled amber while one runs, filled blue while one
has an unread reply, a green outline otherwise, and a dim outline while
ghostd is unreachable, in the theme's red, yellow, blue, and green. It fills
the host's `bar.barSize` across the bar and its 27px icon slot along it, shows
its tooltip through the host's `bar.showTooltip`/`hideTooltip`, and toggles
the HUD on a left click through the host's drag-aware `triggerPress`.

**Questions** a ghost asks (`ghost ask`) show on the presence card and above
the chat composer, with their suggested answers as buttons (1–6 on the card);
a chosen answer is sent as the owner's message, and `dismiss` withdraws the
question.

**Dictation** in the composer: the mic starts Voxtype when idle and stops it
when recording, and is disabled while it transcribes; Esc or the cancel
control cancels a recording or a transcription. A `voxtype record` command
that fails shows as status text above the field until the next one; Voxtype
reports no failed transcription, so the HUD shows none.

Every QML import here is a relative path. Inside the host, `qs.` resolves to
Omarchy's shell root, so `import qs.services` would bind these files to
Omarchy's modules instead of ours.

Installation and use: [getting started](../../docs/getting-started.md).
Integration samples: [contrib](contrib/README.md).
Preview and focused checks: [dev](dev/README.md).

The `Ghostd` singleton serves HUD and bar state over authenticated HTTP/SSE.
Durable state changes use the daemon API; the workbench editor alone writes
ordinary files at the owner's direction. Preview those writes in isolation.

## Theme

Ghost is an Omarchy app and does not carry its own design system. Omarchy 4
publishes one, and `qml/services/Theme.qml` reads it out of the active theme
copy at `~/.local/state/omarchy/current/theme/`:

- `colors.toml` — the palette. `background` is the canvas, the same colour
  Omarchy gives its bar and popups, and `dark_background` recesses a well
  such as a code block. Dim text is walked from the
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
