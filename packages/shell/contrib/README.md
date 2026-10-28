# Desktop integration

The package installs the desktop entry, icons, and keybinding samples here.
For installation and HUD use, follow
[getting started](../../../docs/getting-started.md); installed runtime guidance
is `/usr/share/doc/ghost/ARCH.md`.

## The summon key

On a Lua config (Omarchy 4) the plugin binds `SUPER+CTRL+G` itself at runtime
when no binding of yours holds it, and sets its window rule
(`DesktopKeys.qml`). [`hyprland/ghost.lua`](hyprland/ghost.lua) binds the
summon toggle for another key. A `.conf` config cannot run the shell's Lua, so
[`hyprland/ghost.conf`](hyprland/ghost.conf) carries both the bind and the
window rule; source it, and change the key there to summon on another. The package ships both to
`/usr/share/doc/ghost/shell-contrib/hyprland/` as samples; copy the one your
config uses. Nothing here edits your Omarchy configuration.

## The desktop entry

[`ghost.desktop`](ghost.desktop) and [`icons/`](icons) give Ghost an
application entry and a hicolor icon so it appears in launchers. The package
installs both. The entry opens history and settings with `ghost section home`, a
summon, not a toggle: launching an app shows it, never hides it.
