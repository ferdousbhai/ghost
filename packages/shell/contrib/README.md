# Desktop integration

The package installs the desktop entry, icons, and keybinding samples here.
For installation and HUD use, follow
[getting started](../../../docs/getting-started.md); installed runtime guidance
is `/usr/share/doc/ghost/ARCH.md`.

## The summon key

[`hyprland/ghost.lua`](hyprland/ghost.lua) binds `SUPER+CTRL+G` to the toggle
for Omarchy 4's Lua config; [`hyprland/ghost.conf`](hyprland/ghost.conf) is the
same for a `.conf` config. The package ships both to
`/usr/share/doc/ghost/shell-contrib/hyprland/` as samples; copy the one your
config uses. Nothing here edits your Omarchy configuration.

## The desktop entry

[`ghost.desktop`](ghost.desktop) and [`icons/`](icons) give Ghost an
application entry and a hicolor icon so it appears in launchers. The package
installs both. The entry runs `summon`, not `toggle`: launching an app shows
it, never hides it.
