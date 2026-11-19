# Desktop integration

The package installs the icons and keybinding samples here.
For installation and HUD use, follow
[getting started](../../../docs/getting-started.md); installed runtime guidance
is `/usr/share/doc/ghost/ARCH.md`.

## The summon key

On a Lua config (Omarchy 4) the plugin binds `SUPER+CTRL+G` itself at runtime
when no binding of yours holds it, and sets its window rule
(`DesktopKeys.qml`). [`hyprland/ghost.lua`](hyprland/ghost.lua) is that
binding written into your own config; change its key to summon on another as
well (the shell still claims `SUPER+CTRL+G` while nothing else holds it). A `.conf` config cannot run the shell's Lua, so
[`hyprland/ghost.conf`](hyprland/ghost.conf) carries both the bind and the
window rule; source it, and change the key there to summon on another. The package ships both to
`/usr/share/doc/ghost/shell-contrib/hyprland/` as samples; copy the one your
config uses. Nothing here edits your Omarchy configuration.

## The icon

[`icons/`](icons) is Ghost's hicolor icon, which the package installs. The
launcher entry is the window's
([`io.github.ferdousbhai.Ghost.desktop`](../../window/contrib/io.github.ferdousbhai.Ghost.desktop)):
it opens Ghost's window, not the HUD. The HUD's history and settings open with
`omarchy-shell ghost section home`, a summon, not a toggle.
