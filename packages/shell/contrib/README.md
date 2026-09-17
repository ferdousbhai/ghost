# Desktop integration

The files in this directory, and nothing else. Ghost's HUD is an
[omarchy-shell](https://github.com/omacom/omarchy) plugin, so installing,
summoning, and removing it are the plugin's own README —
`/usr/share/ghost/plugin/README.md`, or
[`../qml/README.md`](../qml/README.md) in a checkout. The plugin runs inside
the shell Omarchy already starts: no unit, no second Quickshell process, no
tray helper.

## The summon key

[`hyprland/ghost.lua`](hyprland/ghost.lua) binds `SUPER+CTRL+G` to the toggle
for Omarchy 4's Lua config; [`hyprland/ghost.conf`](hyprland/ghost.conf) is the
same for a `.conf` config. The package ships both to
`/usr/share/doc/ghost/shell-contrib/hyprland/` as samples; copy the one your
config uses. Nothing here edits your Omarchy configuration.

## The desktop entry

[`ghost.desktop`](ghost.desktop) and [`icons/`](icons) give Ghost an
application entry and a hicolor icon so it appears in launchers. The package
installs both.
