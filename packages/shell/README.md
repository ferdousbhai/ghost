# @ghost/shell

Omarchy-native desktop surfaces for `ghostd`, built with
[Quickshell](https://quickshell.org) (QML).

The chat HUD is a normal application window — a Quickshell `FloatingWindow`
(xdg-toplevel), app-id `ghost` — so Hyprland tiles it, resizes it, and moves it
between workspaces with its own binds, exactly like any app. `SUPER+G` is
launch-or-focus, not an overlay toggle. The persistent chrome around it stays in
the layer/tray world: the bar widget is a wlr-layer surface and the tray icon is
a StatusNotifierItem, both alive for as long as the shell runs and wearing
whatever theme the desktop wears.

```
qml/
  shell.qml            entry point: surfaces, IPC, notification wiring, AppId
  GhostHud.qml         the chat window (FloatingWindow / xdg-toplevel)
  GhostBarWidget.qml   status dot + ghost name, embeddable
  GhostBarSurface.qml  opt-in standalone layer strip carrying the widget
  TrayBridge.qml       system-tray (StatusNotifierItem) presence, via a helper
  tray/ghost-tray.py   the SNI + DBusMenu D-Bus object Quickshell cannot expose
  components/          chat, ask, queue, tool-card, routing and orb UI
  services/            Ghostd, Theme, Notifier (singletons)     → qs.services
contrib/               keybinds, systemd unit, Omarchy bar integration
dev/                   mock daemon, demo script, lint
```

Install steps live in [`contrib/README.md`](contrib/README.md); development and
what was verified how live in [`dev/README.md`](dev/README.md).

## The three decisions worth knowing

**SSE without a helper process.** Qt's QML `XMLHttpRequest` fires
`onreadystatechange` repeatedly at `readyState 3`, once per network chunk, and
exposes the cumulative body in `responseText` — measured here for both GET and
POST before any UI existed. So `Ghostd` streams pi-messages directly: track a
consumed offset, buffer the trailing partial frame, parse `data:` lines. No
`Process` running `curl -N`, no line-parser plumbing. Two things the pattern
demands: `responseText` is cumulative (never treat a `readyState 3` body as a
delta), and the request object must be held in a property or it can be
collected mid-flight.

**One process, one client.** The HUD and the bar widget share a single `Ghostd`
singleton, so the bar dot reflects live turn state with no polling and no
second connection to the daemon. The one place that cannot work is inside
*Omarchy's* bar, which is a different process — see `contrib/README.md` for
that trade.

**A normal window, not a layer surface.** The HUD is a `FloatingWindow`, so it
is a real xdg-toplevel: `hyprctl clients` lists it, the WM tiles and resizes it,
and `SHIFT+SUPER+<n>` moves it between workspaces — no custom screen-move code.
Its app-id is set process-wide by `//@ pragma AppId ghost` (an *instance*
pragma, so it must live in `shell.qml`), which is the class Hyprland exposes for
`windowrule`s. `SUPER+G` (`toggle`) is launch-or-focus: reveal+focus when hidden
or unfocused, hide only when already focused. It replaced an earlier layer-shell
HUD whose `HyprlandFocusGrab` and custom `moveNext` monitor-move IPC existed only
because a layer surface is invisible to the WM's own window binds.

## Harness interaction

The HUD follows modern OMP's interaction model. A model selection closes the
switcher immediately and returns focus to chat. The advanced routing view binds
Chat, Vision, Titles, General, and Research primaries plus ordered retry
fallbacks. Within each provider, current model families sort ahead of older
versions.

OMP's built-in `ask` appears as a structured in-chat form. It supports offered
options, custom input, notes, multiple selection, chat-about-this, and cancel;
it is separate from tool approval, which Ghost does not expose. While a model
is streaming, Enter steers the active run, Ctrl+Enter queues a follow-up, and
Shift+Enter inserts a newline. The queued state is visible below the composer.

Tool calls persist as lifecycle cards with bounded summaries and error/fallback
states. User messages expose editable branch points and sibling navigation;
historical ask cards can be re-answered to create a sibling branch and resume
generation from it.

The activity line uses the recovered summon-ghost spectral orb and rotating,
tool-aware summoning copy. The QML port traces to summon-ghost commit
`be07ca78c95fe38dae105866f7543283f483443b` (the mature glow-clipping fix).
Its aura is deliberately unclipped, the line keeps a stable height, and motion
can be disabled with `GHOST_REDUCE_MOTION=1`.

## System tray

The ghost also shows up as a system-tray icon — a StatusNotifierItem — for as
long as the shell is running: a ghost glyph tinted to the theme (dim when idle,
accent while streaming, red when `ghostd` is unreachable), tooltip'd with the
active ghost's name, left-click to toggle the HUD, and a DBusMenu with Summon,
a radio entry per ghost in the roster, "Choose a model", and Quit.

Quickshell 0.3.0 can *consume* an SNI (`Quickshell.Services.SystemTray`) but
exposes nothing to *produce* one — no generic D-Bus object or bus-name API
anywhere in its QML surface. So the D-Bus object lives in a tiny helper,
`tray/ghost-tray.py` (dbus-python + GLib), which `TrayBridge.qml` spawns as a
child of the shell: it is alive exactly when the shell is, no watcher needed.
The shell pushes live `Ghostd`/`Theme` state down the helper's stdin and the
helper pushes clicks back up its stdout, so there is still one `Ghostd` client
and every ghost decision stays in QML. See `dev/README.md` for what was proven
against a live tray.

## Theming

Reads Omarchy's active theme from
`~/.local/state/omarchy/current/theme/colors.toml` (colours, `mode`) and
`shell.toml` (bar sizing, font), and re-reads on theme switch by watching
`theme.name` — the one file that survives `omarchy-theme-set`'s
`rm -rf theme/ && mv next-theme/ theme/`. Without Omarchy it falls back to a
Tokyo Night palette, so the surfaces still run on bare Hyprland.

## IPC

```sh
qs -c ghost ipc call ghost toggle
qs -c ghost ipc call ghost open|close
qs -c ghost ipc call ghost summon <name>
qs -c ghost ipc call ghost ask "<prompt>"     # reply arrives as a notification
qs -c ghost ipc call ghost login              # open "Connect a model"
qs -c ghost ipc call ghost loginTo <id> <oauth|api_key>   # and start one
qs -c ghost ipc call ghost switcher           # open the model switcher
qs -c ghost ipc call ghost status             # JSON
qs -c ghost ipc call ghost refresh            # re-read roster and theme
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GHOSTD_HOST` | `127.0.0.1` | daemon host (loopback only) |
| `GHOSTD_PORT` | `7717` | daemon port |
| `GHOSTD_API_TOKEN_FILE` | `$XDG_STATE_HOME/ghost/api-token` | the `0600` file holding the API bearer token the daemon mints at startup; `Ghostd.qml` reads it and sends `Authorization: Bearer …` on every request, re-reading once on a `401` so `ghostd api-token --rotate` does not need a shell restart |
| `GHOST_BAR_SURFACE` | unset | `1` puts up the standalone bar strip |
| `GHOST_HUD_REPLAY` | unset | `1` replays local history in every request instead of relying on `options.sessionId` |
| `GHOST_REDUCE_MOTION` | unset | `1`, `true`, or `yes` keeps the spectral orb and activity copy static |

## Status

The daemon is real now: `ghostd` is built, dogfooded, and runs as a systemd
user service. `dev/mock-ghostd.mjs` is a development harness — it implements
enough of the CONTRACTS.md API to build and demo every surface without the
daemon, pi, or a model — not a stand-in for something that does not exist. The
client assumes the daemon owns conversation history, keyed by
`options.sessionId`; set `GHOST_HUD_REPLAY=1` if a build turns out to be
stateless per request.
