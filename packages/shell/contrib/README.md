# Desktop integration

The package installs the desktop entry, icons, and keybinding samples here.
For installation and HUD use, follow
[getting started](../../../docs/getting-started.md); installed runtime guidance
is `/usr/share/doc/ghost/ARCH.md`.

## The summon key

The plugin binds `SUPER+CTRL+G` itself at runtime when no binding of yours
holds it (`DesktopKeys.qml`). These samples are for anything else:
[`hyprland/ghost.lua`](hyprland/ghost.lua) binds the summon toggle for Omarchy
4's Lua config and [`hyprland/ghost.conf`](hyprland/ghost.conf) for a `.conf`
config; change the key there to summon on another. The package ships both to
`/usr/share/doc/ghost/shell-contrib/hyprland/` as samples; copy the one your
config uses. Nothing here edits your Omarchy configuration.

## The desktop entry

[`ghost.desktop`](ghost.desktop) and [`icons/`](icons) give Ghost an
application entry and a hicolor icon so it appears in launchers. The package
installs both. The entry opens history and settings with `ghost section home`, a
summon, not a toggle: launching an app shows it, never hides it.
