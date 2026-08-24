# Installing the ghost shell on Omarchy

Everything here is a snippet you copy, not something a script does to your
machine. The shell is a Quickshell config; installing it means putting the QML
where `qs` looks and telling Hyprland which key summons it.

Tested on Omarchy 4.0.0.alpha, Hyprland 0.56.2, Quickshell 0.3.0, Qt 6.11.2.

## 1. Install the config and launcher

`qs -c ghost` resolves `$XDG_CONFIG_HOME/quickshell/ghost/shell.qml`. Symlink
the checkout so a `git pull` updates the running shell:

```sh
mkdir -p ~/.config/quickshell
ln -sfn "$PWD/packages/shell/qml" ~/.config/quickshell/ghost
install -Dm755 packages/shell/contrib/bin/ghost-launch ~/.local/bin/ghost-launch
install -Dm644 packages/shell/contrib/ghost.desktop ~/.local/share/applications/ghost.desktop
update-desktop-database ~/.local/share/applications
```

Point it at a daemon on a non-default port with `GHOSTD_PORT` / `GHOSTD_HOST`
(defaults `7717` / `127.0.0.1`, matching `@ghost/daemon`).

`ghost-launch open` starts the shell when needed and then opens its HUD. The
desktop entry uses that command, so Ghost appears in app launchers and still
works when the shell was not already running.

## 2. Summon key

Omarchy 4 configures Hyprland in Lua. Append the binding lines from
`hyprland/ghost.lua` to `~/.config/hypr/bindings.lua` and the layer rule to
`~/.config/hypr/looknfeel.lua`:

```lua
o.bind("SUPER + CTRL + G", "Summon ghost", "ghost-launch toggle")
hl.layer_rule({ match = { namespace = "^ghost-" }, no_anim = true, animation = "none" })
```

This deliberately leaves Omarchy's `SUPER+G` window-grouping shortcut intact.

On a plain (non-Omarchy) Hyprland, `source` `hyprland/ghost.conf` instead.

`SUPER+CTRL+G` is **launch-or-focus**: the chat HUD is a normal toplevel window
(app-id `ghost`), so the key reveals and focuses it, pulls it to the front if it
is already open on another workspace, and hides it only when it is already the
focused window. Because it is a real window, Hyprland's own binds move it —
`SHIFT+SUPER+<n>` sends it to a workspace, and it tiles/resizes in the normal
layout — so there is no move-to-monitor keybind to install any more. To float it
at a fixed size instead of tiling, add a `windowrule`/`window_rule` against
`class:^(ghost)$`; both contrib files carry commented examples.

> The IPC function names avoid `show`, `call`, `wait`, `listen`, `prop`, `log`,
> `list` and `kill`. Quickshell's CLI lets subcommands fall through positional
> arguments, so `qs ipc call ghost show` silently runs `qs ipc show`. Keep that
> in mind if you add your own IPC functions.

## 3. Autostart

Either systemd (survives a shell crash, restarts with the session):

```sh
install -Dm644 packages/shell/contrib/systemd/ghost-shell.service ~/.config/systemd/user/ghost-shell.service
systemctl --user daemon-reload
systemctl --user enable --now ghost-shell.service
```

or let Hyprland own it — `o.launch_on_start("qs -c ghost")` in
`~/.config/hypr/autostart.lua`. Do not do both.

## 4. Bar indicator

**The recommendation is to put the indicator in Omarchy's bar, not to run a
second bar.** Omarchy 4 has a real module system for exactly this, and two bars
stacked on one screen edge is a worse desktop than no indicator.

Omarchy's bar accepts third-party modules three ways; this package ships the
two that need no plugin manifest:

| | `omarchy/bar-modules/ghost.qml` | `omarchy/scripts/ghost-bar-status` |
|---|---|---|
| type | `"qml"` | `"command"` |
| install to | `~/.config/omarchy/bar/modules/ghost.qml` | `~/.config/omarchy/bar/scripts/ghost-bar-status` |
| pulsing dot | yes | no |
| survives an Omarchy widget-contract change | probably | certainly |
| cost | one `qs ipc` subprocess every 2s | same |

Then merge the matching entry from `omarchy/shell.json.snippet` into
`~/.config/omarchy/shell.json` and reload with `omarchy-shell shell rescanPlugins`
(or just save the file — the bar watches it).

Either way the module runs **inside the omarchy-shell process**, so it cannot
see our `Ghostd` singleton and asks our shell for state over IPC instead. That
is the whole trade: an in-bar indicator is a poller; the HUD's own
`GhostBarWidget` is live. A bar dot does not need per-token fidelity.

The third route — a full plugin under `~/.config/omarchy/plugins/<id>/` with a
`manifest.json` — buys a settings schema and catalog installability. Worth
doing once the shell stabilises; note that the `omarchy.*` id namespace is
reserved and rejected at scan time, so it would be `ferdousbhai.ghost`.

### If you are not on Omarchy

Set `GHOST_BAR_SURFACE=1` and the shell puts up its own small layer strip
(`GhostBarSurface.qml`, namespace `ghost-bar`, bottom-right, no exclusive
zone). It is off by default for the reason above.

## System tray

Nothing to install: whenever the shell runs, `TrayBridge.qml` spawns
`qml/tray/ghost-tray.py`, which puts a ghost StatusNotifierItem in any SNI tray
(Omarchy's bar included) — left-click toggles the HUD, right-click opens a menu
of Summon / per-ghost switch / Connect a model / Quit. It needs the two Python
D-Bus bindings, both stock on Arch/Omarchy:

```sh
sudo pacman -S --needed python-dbus python-gobject
```

Missing them, the helper exits and only the tray icon is absent; the rest of the
shell is unaffected. This is separate from — and complementary to — the in-bar
indicator above: the tray item is the shell advertising itself system-wide, the
bar module is Omarchy's bar polling the shell.

## Window and layer namespaces

The chat HUD is a normal toplevel window with **app-id `ghost`** (set by
`//@ pragma AppId ghost` in `shell.qml`) — target it with `class:^(ghost)$` in a
`windowrule`. The only remaining layer surface is the opt-in bar strip,
namespace **`ghost-bar`**. Deliberately not prefixed `omarchy-`: Omarchy's own
`omarchy-bar` layer rule is unanchored, so any namespace *containing*
`omarchy-bar` would silently inherit it.
