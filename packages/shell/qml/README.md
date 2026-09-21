# Ghost — an omarchy-shell plugin

Ghost's desktop surfaces as an omarchy-shell plugin, id `ferdousbhai.ghost`:
a chat window with its own character, tools, and desktop reach, and a bar mark
that lights up while it is working. The Hyprland keybind samples and the
desktop entry are in [`../contrib/`](../contrib/README.md).

## It arrives with the `ghost` package

This directory is half of one product. The other half is `ghostd`, a loopback
daemon that owns sessions, models, and every ghost's home, and the two must be
the same version. So the package is the only way in: it installs these files
to `/usr/share/ghost/plugin` and prints the rest for you to run — a package may
not write into your home, so the link and the enable are yours.

```sh
omarchy-pkg-add ghost          # or: Install → AI → Ghost; until Omarchy's repository
                               # carries it, `curl -fsSL https://summonghost.com/install | bash`
                               # adds Ghost's signed repository and does all of this
systemctl --user enable --now ghostd.service
ln -sfn /usr/share/ghost/plugin ~/.config/omarchy/plugins/ferdousbhai.ghost
omarchy-shell shell rescanPlugins && omarchy plugin enable ferdousbhai.ghost
```

There is deliberately no `omarchy plugin add` git checkout of this: a second
channel cannot keep the window and the daemon on the same version, and a
checkout that shadows the packaged copy is a skew nobody would see.

From a checkout, link `packages/shell/qml` instead. A save does not reload it:
the entry-point URL is unchanged, so the shell keeps the widget it loaded.
Only `omarchy-restart-shell` replaces it.

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

Add the bar dot from _Setup → Plugins_, or `omarchy bar move ferdousbhai.ghost
right`. It lives in the same process as the panel and reads the same live
daemon connection, so it lights the instant a turn starts — no polling, no
second connection.

`omarchy plugin list` shows the plugin; `omarchy plugin disable
ferdousbhai.ghost` turns it off without removing anything.

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

Apache-2.0, with the repository's [LICENSE](../../../LICENSE).
