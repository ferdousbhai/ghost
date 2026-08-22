# Installing the ghost shell on Omarchy

Everything here is a snippet you copy, not something a script does to your
machine. The shell is a Quickshell config; installing it means putting the QML
where `qs` looks and telling Hyprland which key summons it.

Tested on Omarchy 4.0.0.alpha, Hyprland 0.56.2, Quickshell 0.3.0, Qt 6.11.2.

## 1. Install the config

`qs -c ghost` resolves `$XDG_CONFIG_HOME/quickshell/ghost/shell.qml`. Symlink
the checkout so a `git pull` updates the running shell:

```sh
mkdir -p ~/.config/quickshell
ln -sfn "$PWD/packages/shell/qml" ~/.config/quickshell/ghost
qs -c ghost ipc call ghost status     # should print JSON
```

Point it at a daemon on a non-default port with `GHOSTD_PORT` / `GHOSTD_HOST`
(defaults `7717` / `127.0.0.1`, matching `@ghost/daemon`).

## 2. Summon key

Omarchy 4 configures Hyprland in Lua. Append the two lines from
`hyprland/ghost.lua` to `~/.config/hypr/bindings.lua` and
`~/.config/hypr/looknfeel.lua`:

```lua
o.bind("SUPER + G", "Summon ghost", "qs -c ghost ipc call ghost toggle")
hl.layer_rule({ match = { namespace = "^ghost-" }, no_anim = true, animation = "none" })
```

On a plain (non-Omarchy) Hyprland, `source` `hyprland/ghost.conf` instead.

> The IPC function names avoid `show`, `call`, `wait`, `listen`, `prop`, `log`,
> `list` and `kill`. Quickshell's CLI lets subcommands fall through positional
> arguments, so `qs ipc call ghost show` silently runs `qs ipc show`. Keep that
> in mind if you add your own IPC functions.

## 3. Autostart

Either systemd (survives a shell crash, restarts with the session):

```sh
install -Dm644 systemd/ghost-shell.service ~/.config/systemd/user/ghost-shell.service
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

## Layer namespaces

`ghost-hud` and `ghost-bar`. Deliberately not prefixed `omarchy-`: Omarchy's
own `omarchy-bar` layer rule is unanchored, so any namespace *containing*
`omarchy-bar` would silently inherit it.
