# Checkout package recipe

`PKGBUILD` builds two rolling packages: `ghost-runtime-dev` (daemon, CLI,
desktop automation) and `ghost-dev` (the Omarchy UI). They provide
and conflict with stable `ghost-runtime` and `ghost`, respectively. The UI
requires the exact matching runtime version.
`/usr/bin/ghostd` and `/usr/bin/ghost` are fixed launchers for ordinary
Bun-target bundles under `/usr/lib/ghost/runtime`. The package depends on
system Bun 1.3.14 or newer at runtime; building and checking the current
toolchain requires Bun 1.4.0 or newer. It installs no source or `node_modules`
tree. Ghost's application code and its MCP support remain packaged for
offline use; the agent CLIs a ghost's turns run on are the owner's own.

The stable `ghost` release-source machinery lives under `packaging/release/`; its
v3 runtime source carries the same bundles, launchers, and exact bundled-license
closure.

Build the checkout package without installing it:

```sh
makepkg --cleanbuild
# CI uses a disposable native Arch root (requires arch-install-scripts and root):
sudo packaging/arch/arch-run.sh packaging/arch/build-native.sh
```

The chroot command expects, on ARM, the checksum-verified upstream Bun
binary at `.ci/bun/bun`. The workflow prepares these before invoking it.

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
requirement. It retains screen/desktop tools and Bash browser automation, so
it still requires the supported Hyprland graphical environment. This is an
install without the Ghost HUD, not a replacement desktop-automation backend.
The daemon remains bound to the graphical session and loopback. An app uses the
existing bearer-authenticated HTTP/SSE API; it must render and answer pending
questions through conversation replies.
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

MCP servers, CLI integrations, and product skills are yours to install from
upstream as the desktop user; the upstream installer then owns its files and
updates. Many MCP servers are launched through `npx`, which the optional `npm`
package provides.

The package ships Ghost's own skills under `/usr/lib/ghost/skills`, linked into
every conversation directory with the ghost's own skills: `ghost-products`
indexes the recommended products; `web-browser` teaches shared Chromium
sessions and task tabs. Each product installs its own skill
(`<cli> skill install`). Machine skills are whatever each agent CLI discovers on
its own.

This remains the rolling, checkout-only development package: `pnpm install`
may populate its store during `build()`. The stable `ghost-runtime` package uses the
[v3 runtime-source mechanism](../release/README.md#reproducibility-boundary)
and also installs `/usr/bin/ghostd` and `/usr/bin/ghost`. Ghost publishes the
source and runtime inputs as a GitHub release (`../release/publish.sh`);
Omarchy's package repository carries `ghost` and owns the stable package
build and promotion (see [the release README](../release/README.md)).

The HUD is installed at `/usr/share/ghost/plugin` as an omarchy-shell plugin.
The package does not write into a user's config directory, so linking it into
`~/.config/omarchy/plugins/` and enabling it is the step the install script prints for the owner to run.
Browser automation uses the optional agent-browser CLI through Bash. Computer use is
`ghost-desktop`, a stdio MCP server bundled like `ghostd`; any MCP client can run
it, not only Ghost.

## Desktop boundary

The supported release target is Omarchy. Ghost depends on Omarchy's Hyprland
and Quickshell desktop shape, and carries its keybinding samples under
`/usr/share/doc/ghost/shell-contrib/` for the owner to enable. There is no generic Arch/Hyprland support promise. Packaging never
edits `~/.config/hypr` or `~/.config/omarchy`.

## Upgrades, rollback, and uninstall

The package owns only files under `/usr`; the HUD's per-user link is the
owner's. It does not create or own `~/ghosts`,
`~/.config/ghost`, or `~/.local/state/ghost`. Upgrading or removing it therefore
leaves personas, documents, sessions, provider credentials, and API tokens
untouched. Its removal hook likewise leaves owner documents and any
owner-installed machine skill untouched.

A runtime upgrade requires `systemctl --user restart ghostd.service` to load
the new bundle; an installed HUD also needs `omarchy-restart-shell`.
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
the ghost-desktop bundle, desktop entry, Quickshell assets,
and graphical-session service binding. `package()` runs it before producing the
archive. `pnpm verify` is the gate: the pre-push hook refuses a master push
until it has passed on that exact tree, and the `Native packages` workflow
builds this PKGBUILD (which runs the same checks) in clean Arch Linux x86_64
and Arch Linux ARM aarch64 chroots on every pull request and master push.
Releases are cut locally.

For a real service-context check on a graphical Arch login, run:

```sh
/usr/lib/ghost/package-smoke/service-smoke.sh
```

It uses `/usr/bin/ghost status` to verify that the terminal client can
authenticate to the active packaged daemon. CI chroots do not run a graphical
user manager, so this stays a release-machine check.
