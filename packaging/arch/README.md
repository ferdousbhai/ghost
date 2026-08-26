# Arch and Omarchy package

`PKGBUILD` builds `ghost-ai-git`, the development package for the first
owner-local beta. The `ghost-git` AUR name already belongs to an unrelated
screenshot utility, hence the collision-free package name. JavaScript runtime
dependencies come from the repository's frozen `pnpm-lock.yaml`; minimum system
runtime versions are declared in the package metadata. The stable `ghost-ai`
template and release-source machinery live under `packaging/release/` and are
installed for reference as `RELEASE-SOURCE.md`.

Build and install from this directory:

```sh
makepkg -si
systemctl --user enable --now ghostd.service ghost-shell.service
```

This remains the rolling development package: `pnpm install` may populate its
store during `build()`, so it is not the AUR release recipe. Release CI now
constructs a deterministic, architecture-specific runtime source from the
frozen lock/vendor inputs, pairs it with the exact tagged source archive, and
renders a fixed-checksum stable `ghost-ai` PKGBUILD whose package phases are
fully offline. Nothing is published automatically. Issue #17 still requires an
actual version tag and GitHub release, inspection of those attached artifacts,
and a human upload of the rendered bundle to the `ghost-ai` AUR package.

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

It launches Playwright's persistent Chromium in a transient user unit with the
daemon's hardening properties and `chromiumSandbox: true`; a passing command
therefore proves the unit does not force `--no-sandbox`. CI containers do not
run a graphical user manager, so this probe is intentionally a release-machine
check. Ghost's Playwright backend opts into the same sandbox setting, so the
probe covers the production launch policy rather than a weaker test-only mode.
