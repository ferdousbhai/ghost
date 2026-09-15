# Checkout package recipe

`PKGBUILD` builds `ghost-dev`, the rolling checkout package. It provides and
conflicts with stable `ghost`, so the variants cannot be installed together.
`/usr/bin/ghostd` and `/usr/bin/ghost` are fixed launchers for ordinary
Bun-target bundles under `/usr/lib/ghost/runtime`. The package depends on
system Bun 1.3.14 or newer at runtime; building and checking the current
toolchain requires Bun 1.4.0 or newer. It installs no source or `node_modules`
tree. Ghost, pi, provider, and MCP application code plus required static assets
remain packaged for offline use.

`fd` and `ripgrep` are explicit runtime dependencies because Pi's native
`find` and `grep` tools invoke them. The
stable `ghost` release-source machinery lives under `packaging/release/`; its
v3 runtime source carries the same bundles, launchers, and exact bundled-license
closure.

Build the checkout package without installing it:

```sh
makepkg --cleanbuild
```

## Owner-shared state

Shared notes, knowledge, decisions, plans, and tasks live in the owner's XDG
Documents directory. Every ghost reads and writes it with its runtime's native
file tools; the package installs nothing there and gates nothing on it.

## Optional integrations

Skills, MCP servers, and CLI integrations are yours to install from upstream
as the desktop user; the upstream installer then owns its files and updates,
and Ghost packages none of them. Many are launched through `npx`, which the
optional `npm` package provides.

Open a new pi session after installing skills. Ghost uses pi's native parser to
snapshot every valid skill visible under `~/.agents/skills/` and
`~/.pi/agent/skills/`, following symlinks in those standard machine roots.
There is no hardcoded skill-name allowlist or integration-specific package path.

This remains the rolling, checkout-only development package: `pnpm install`
may populate its store during `build()`. The stable `ghost` package uses the
[v3 runtime-source mechanism](../release/README.md#reproducibility-boundary)
and also installs `/usr/bin/ghostd` and `/usr/bin/ghost`. Ghost publishes the
source and runtime inputs as a GitHub release (`../release/publish.sh`) and
renders the Omarchy contribution; Omarchy owns the stable package build,
signing, repository, and promotion. Ghost has no generic Arch publication
channel, pacman repository, or package-signing key.

The HUD is installed at `/usr/share/ghost/plugin` as an omarchy-shell plugin.
The package does not write into a user's config directory, so linking it into
`~/.config/omarchy/plugins/` and enabling it is the install script's step.
The browser relay is installed at `/usr/share/ghost/chromium-extension`; load
that directory with Chromium's **Load unpacked** flow. The computer-use helper
is installed in a private Python import directory and exposed through
`ghost-desktop-helper`, preventing its vendored `omaharness` modules from
colliding with a system Python package.

## Desktop boundary

The supported release target is Omarchy. Ghost depends on Omarchy's Hyprland
and Quickshell desktop shape, and carries its Lua keybinding and optional native
bar integration under `/usr/share/doc/ghost/shell-contrib/` for the owner to
enable. There is no generic Arch/Hyprland support promise. Packaging never
edits `~/.config/hypr` or `~/.config/omarchy`.

## Upgrades, rollback, and uninstall

The package owns only files under `/usr`, plus the system Quickshell symlink at
`/etc/xdg/quickshell/ghost`. It does not create or own `~/ghosts`,
`~/.config/ghost`, or `~/.local/state/ghost`. Upgrading or removing it therefore
leaves personas, documents, sessions, provider credentials, and API tokens
untouched. Its removal hook likewise leaves owner documents and any
owner-installed machine skill untouched.

An upgrade requires `systemctl --user reenable --now ghostd.service` and
`omarchy-shell shell rescanPlugins`; re-enabling also moves an installation made with the old
daemon unit away from `default.target` and into the graphical-session lifecycle.
A package rollback uses the normal pacman cache
(`pacman -U /var/cache/pacman/pkg/<package>.pkg.tar.zst`) and likewise does not
roll back or delete user data. Ghost-home format changes must remain
forward/restart-safe under `CONTRACTS.md`; packaging does not invent a second
migration path.

Before uninstalling `ghost-dev`, stop and disable the user unit:

```sh
systemctl --user disable --now ghostd.service
sudo pacman -Rns ghost-dev
```

For stable `ghost`, the final command is `sudo pacman -Rns ghost`.

That removes package-owned files only. It deliberately leaves `~/ghosts`,
provider credentials, and API/relay tokens untouched.

`smoke.sh` validates a staged package tree, including daemon startup metadata,
the private helper imports, desktop entry, Chromium manifest, Quickshell assets,
and graphical-session service binding. `package()` runs it before producing the
archive, and the Arch workflow builds the package in a clean container on
every push, which is the whole of CI: releases are cut locally.

For a real service-context check on a graphical Arch login, run:

```sh
/usr/lib/ghost/package-smoke/service-browser-smoke.sh
```

It uses `/usr/bin/ghost status --json` to verify that the terminal client can
authenticate to the active packaged daemon, then reads `/api/relay/status` to
verify the browser relay endpoint is serving from it. Ghost launches no browser
of its own — the relay dials out of a Chromium the owner started — so there is
no launch policy to probe. CI containers do not run a graphical user manager, so
this stays a release-machine check.
