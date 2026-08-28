# Arch and Omarchy package

`PKGBUILD` builds `ghost-ai-git`, the development package for the first
owner-local beta. The `ghost-git` AUR name already belongs to an unrelated
screenshot utility, hence the collision-free package name. The daemon is one
self-contained x86_64 executable at `/usr/bin/ghostd`, with Bun embedded and no
installed source or JavaScript dependency tree. Bun remains a package runtime
dependency only because the installed service-context Chromium smoke test uses
it. The stable `ghost-ai` template and release-source machinery live under
`packaging/release/`; its runtime source carries the same compiled daemon.

Build and install from this directory:

```sh
makepkg -si
systemctl --user enable --now ghostd.service ghost-shell.service
```

Before opening a session, install `libsecret` (for `secret-tool`) and run a
user-session Secret Service provider such as `gnome-keyring`; its default
collection must be available to `ghostd`. See
[keyring credentials](../../docs/keyring.md) for failure behavior and the
blank-password/autologin caveat.

This remains the rolling development package: `pnpm install` may populate its
store during `build()`, so it is not the AUR release recipe. The stable package
uses the [v2 runtime-source mechanism](../release/README.md#reproducibility-boundary)
and also installs only `/usr/bin/ghostd`; publishing still requires a version
tag, artifact inspection, and a human upload to the `ghost-ai` AUR package.

The shell is installed at `/usr/share/ghost/quickshell` and exposed as the
system Quickshell config `ghost`, so the existing `qs -c ghost` integration and
`ghost-launch` command work without writing into a user's config directory.
The browser relay is installed at `/usr/share/ghost/chromium-extension`; load
that directory with Chromium's **Load unpacked** flow. The computer-use helper
is installed in a private Python import directory and exposed through
`ghost-desktop-helper`, preventing its vendored `omaharness` modules from
colliding with a system Python package.

## Desktop-specific integration

Ghost itself targets a Hyprland graphical session and depends on Hyprland and
Quickshell. The systemd user services, desktop entry, tray item, notifications,
and the plain Hyprland snippet work on an Arch/Hyprland desktop without
Omarchy. The Omarchy-only pieces are its Lua keybinding form and the optional
native bar module; both are installed below
`/usr/share/doc/ghost/shell-contrib/` for an owner to opt into. Packaging never
edits `~/.config/hypr` or `~/.config/omarchy`.

## Upgrades, rollback, and uninstall

The package owns only files under `/usr`, plus the system Quickshell symlink at
`/etc/xdg/quickshell/ghost`. It does not create or own `~/ghosts`,
`~/.config/ghost`, `~/.local/state/ghost`, or a browser profile. Upgrading or
removing it therefore leaves personas, docs, memory, sessions, provider
credentials, API tokens, and browser state untouched.

An upgrade requires `systemctl --user reenable --now ghostd.service
ghost-shell.service`; re-enabling also moves an installation made with the old
daemon unit away from `default.target` and into the graphical-session lifecycle.
A package rollback uses the normal pacman cache
(`pacman -U /var/cache/pacman/pkg/<package>.pkg.tar.zst`) and likewise does not
roll back or delete user data. Ghost-home format changes must remain
forward/restart-safe under `CONTRACTS.md`; packaging does not invent a second
migration path.

Before uninstalling either package, stop and disable both user units:

```sh
systemctl --user disable --now ghost-shell.service ghostd.service
sudo pacman -Rns ghost-ai-git
```

For the stable package, the final command is `sudo pacman -Rns ghost-ai`.

That removes package-owned files only. It deliberately leaves `~/ghosts`,
provider credentials, API/relay tokens, and browser profiles untouched.

`smoke.sh` validates a staged package tree, including daemon startup metadata,
the private helper imports, desktop entry, Chromium manifest, Quickshell assets,
and graphical-session service binding. `package()` runs it before producing the
archive, and the Arch workflow builds the package in a clean container.

For a real service-context Chromium check on a graphical Arch login, run:

```sh
/usr/lib/ghost/package-smoke/service-browser-smoke.sh
```

It launches Chromium with a CDP endpoint in a transient user unit with the
daemon's hardening properties and without `--no-sandbox`; a passing command
therefore proves the unit permits Chromium's sandbox. CI containers do not run
a graphical user manager, so this probe is intentionally a release-machine
check. Ghost's Playwright backend opts into `chromiumSandbox: true`, so the
probe covers the production launch policy rather than a weaker test-only mode.
