# Checkout package recipe

`PKGBUILD` builds two rolling packages: `ghost-runtime-dev` (daemon, CLI,
relay, and desktop automation) and `ghost-dev` (the Omarchy UI). They provide
and conflict with stable `ghost-runtime` and `ghost`, respectively. The UI
requires the exact matching runtime version.
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

## Runtime with your own UI

Install `ghost-runtime` from the Omarchy package repository for a remote desktop
where an app supplies the UI. Install `ghost` to add the version-matched HUD:

```sh
sudo pacman -Syu ghost-runtime
systemctl --user enable --now ghostd.service
ghost status
# Optional Ghost UI:
sudo pacman -S ghost
```

The runtime package has no Ghost QML, desktop entry, icons, or Quickshell
requirement. It retains screen/desktop tools and the opt-in browser relay, so
it still requires the supported Hyprland graphical environment. This is an
install without the Ghost HUD, not a replacement desktop-automation backend.
The daemon remains bound to the graphical session and loopback. An app uses the
existing bearer-authenticated HTTP/SSE API; it must render and answer pending
`ask` questions and handle browser pairing through the API or `ghost` CLI.
Use an SSH tunnel or the existing Tailscale boundary for access from another
machine; installing only the runtime does not expose the API publicly.

To remove the UI while retaining an app's backend:

```sh
sudo pacman -D --asexplicit ghost-runtime
omarchy plugin remove ferdousbhai.ghost --yes
sudo pacman -R ghost
omarchy-restart-shell
```

The Omarchy **Remove → AI → Ghost UI** action also preserves the runtime.
For checkout builds use the `-dev` package names. Building produces both
archives; install just the `ghost-runtime-dev` archive when supplying your own UI.

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
may populate its store during `build()`. The stable `ghost-runtime` package uses the
[v3 runtime-source mechanism](../release/README.md#reproducibility-boundary)
and also installs `/usr/bin/ghostd` and `/usr/bin/ghost`. Ghost publishes the
source and runtime inputs as a GitHub release (`../release/publish.sh`) and
renders the Omarchy contribution; Omarchy owns the stable package build,
signing, repository, and promotion. Ghost has no generic Arch publication
channel, pacman repository, or package-signing key.

The HUD is installed at `/usr/share/ghost/plugin` as an omarchy-shell plugin.
The package does not write into a user's config directory, so linking it into
`~/.config/omarchy/plugins/` and enabling it is the step the install script prints for the owner to run.
The browser extension is its own product and is not in this package: install
Ghost for Chromium from the Chrome Web Store or from
<https://github.com/ferdousbhai/ghost-chromium-extension>. The computer-use helper
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

The package owns only files under `/usr`; the HUD's per-user link is the
owner's, and `smoke.sh` fails the build if
a system Quickshell link reappears. It does not create or own `~/ghosts`,
`~/.config/ghost`, or `~/.local/state/ghost`. Upgrading or removing it therefore
leaves personas, documents, sessions, provider credentials, and API tokens
untouched. Its removal hook likewise leaves owner documents and any
owner-installed machine skill untouched.

A runtime upgrade requires `systemctl --user reenable --now ghostd.service`;
an installed HUD also needs `omarchy-restart-shell`. Re-enabling moves an installation made with the old
daemon unit away from `default.target` and into the graphical-session lifecycle.
A rescan will not do here: the plugin's entry point is unchanged, so the shell
keeps the widget it already loaded and the owner runs a new daemon behind an
old HUD.
A package rollback uses the normal pacman cache
(`pacman -U /var/cache/pacman/pkg/<package>.pkg.tar.zst`) and likewise does not
roll back or delete user data. Ghost-home format changes must remain
forward/restart-safe under `CONTRACTS.md`; packaging does not invent a second
migration path.

To remove the complete checkout installation, stop and disable the user unit:

```sh
systemctl --user disable --now ghostd.service
sudo pacman -Rns ghost-dev ghost-runtime-dev
```

For the complete stable installation, use `sudo pacman -Rns ghost ghost-runtime`.
If only the runtime is installed, name only `ghost-runtime`.

That removes package-owned files only.

`smoke.sh <root> <runtime|ui>` validates each disjoint staged package tree, including daemon startup metadata,
the private helper imports, desktop entry, Chromium manifest, Quickshell assets,
and graphical-session service binding. `package()` runs it before producing the
archive. There is no hosted CI: `pnpm verify` is the whole gate, the pre-push
hook refuses a master push until it has passed on that exact tree, and
releases are cut locally.

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
