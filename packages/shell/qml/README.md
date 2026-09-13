# Ghost — an omarchy-shell plugin

An owner-local AI persona for Omarchy: a chat window with its own character,
tools, and desktop reach, and a bar dot that lights up while it is working.

This repository is the HUD. It is published from
[`ferdousbhai/ghost`](https://github.com/ferdousbhai/ghost), where the daemon,
CLI, browser relay, and computer-use helper live, and where issues and pull
requests belong.

## Requires the `ghost` package

The plugin is the desktop half. The daemon it talks to — `ghostd` on
`127.0.0.1`, which owns sessions, models, and every ghost's home — ships in the
`ghost` package. Without it the window opens and reports that ghostd is not
answering.

```sh
omarchy-pkg-add ghost          # or: Install → AI → Ghost
systemctl --user enable --now ghostd.service
```

## Install

```sh
omarchy plugin add https://github.com/ferdousbhai/omarchy-ghost.git --enable
```

The `ghost` package also installs these files to `/usr/share/ghost/plugin`; if
you have the package, link that instead of cloning, and the two stay in step:

```sh
ln -sfn /usr/share/ghost/plugin ~/.config/omarchy/plugins/ferdousbhai.ghost
omarchy-shell shell rescanPlugins && omarchy plugin enable ferdousbhai.ghost
```

## Use

```sh
omarchy-shell shell toggle ferdousbhai.ghost   # open or hide the window
omarchy-shell ghost summon casper              # open on a named ghost
omarchy-shell ghost section board              # open on a section
omarchy-shell ghost status                     # what it is doing
```

Bind the toggle to a key — `SUPER+CTRL+G` is the convention:

```lua
o.bind("SUPER + CTRL + G", "Summon ghost", "omarchy-shell shell toggle ferdousbhai.ghost")
```

The window is an ordinary toplevel, so Hyprland tiles, moves, and resizes it
like any app. A window rule must match its **title** (`^Ghost( — .*)?$`), not
an app-id: a plugin's window carries the host shell's app-id.

Add the bar dot from _Setup → Plugins_, or `omarchy bar move ferdousbhai.ghost right`.

## What it does to your system

- Reads and writes `~/ghosts/`, the daemon's ghost homes, through ghostd's
  authenticated loopback API. It holds no credentials itself.
- Talks to `127.0.0.1` only. Remote access is a separate, opt-in Tailscale
  Serve viewer in the daemon.
- Writes nothing outside the daemon's API except files you ask a ghost to
  write, and the workbench editor's explicit saves.
- Changes no Omarchy configuration. The keybind above is yours to add.

## Remove

```sh
omarchy plugin remove ferdousbhai.ghost
```

Your ghosts, settings, and daemon state are untouched.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
