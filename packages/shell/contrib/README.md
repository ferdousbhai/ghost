# Desktop integration

Ghost's HUD is an [omarchy-shell](https://github.com/omacom/omarchy) plugin,
id `ferdousbhai.ghost`. It runs inside the shell Omarchy already starts, so
there is no unit, no second Quickshell process, and no tray helper to install.
What is left here is the summon key and the desktop entry.

## Install the plugin

The package installs the plugin's files to `/usr/share/ghost/plugin`. Link it
into your own plugins directory and enable it:

```sh
mkdir -p ~/.config/omarchy/plugins
ln -sfn /usr/share/ghost/plugin ~/.config/omarchy/plugins/ferdousbhai.ghost
omarchy-shell shell rescanPlugins
omarchy plugin enable ferdousbhai.ghost
```

From a checkout, link `packages/shell/qml` instead of `/usr/share/ghost/plugin`.
A save does not reload it; `omarchy-restart-shell` does.

`omarchy plugin list` shows it; `omarchy plugin disable ferdousbhai.ghost`
turns it off without removing anything.

## Summon it

```sh
omarchy-shell shell toggle ferdousbhai.ghost
```

[`hyprland/ghost.lua`](hyprland/ghost.lua) binds that to `SUPER+CTRL+G` for
Omarchy 4's Lua config; [`hyprland/ghost.conf`](hyprland/ghost.conf) is the
same for a `.conf` config. The HUD is an ordinary toplevel window, so
Hyprland's own binds move, tile, and resize it like any app. A window rule has
to match its title (`^Ghost( — .*)?$`) rather than an app-id, because a
plugin's window carries the host shell's app-id.

The plugin also registers a `ghost` IPC target for the verbs that carry an
argument:

```sh
omarchy-shell ghost summon casper
omarchy-shell ghost section board
omarchy-shell ghost ask "what is on my board?"
omarchy-shell ghost status
```

## The bar dot

The plugin's `bar-widget` kind puts a state dot and the active ghost's name in
Omarchy's own bar. Add it from _Setup > Plugins_, or:

```sh
omarchy bar move ferdousbhai.ghost right
```

Because the widget lives in the same process as the panel, it reads the same
live daemon connection: the dot lights the instant a turn starts, with no
polling and no second connection.

## Desktop entry

[`ghost.desktop`](ghost.desktop) and [`icons/`](icons) give Ghost an
application entry and a hicolor icon, so it appears in launchers. The package
installs both.
