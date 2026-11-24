# Checkout package recipe

`PKGBUILD` builds one rolling package, `ghost-dev`: the daemon, API and CLI,
and the window. It provides and conflicts with stable `ghost`, and replaces
the `ghost-runtime-dev` package earlier checkouts split the daemon into.
`/usr/bin/ghostd` and `/usr/bin/ghost` are fixed launchers for ordinary
Bun-target bundles under `/usr/lib/ghost/runtime`. The package depends on
system Bun 1.3.14 or newer at runtime; building and checking the current
toolchain requires Bun 1.4.0 or newer. It installs no source or `node_modules`
tree. Ghost's application code is packaged for offline use; the agent CLIs a
ghost's turns run on are the owner's own.

The stable `ghost` release-source machinery lives under `packaging/release/`; its
v3 runtime source carries the same bundles, launchers, and exact bundled-license
closure.

Build the checkout package without installing it (a plain `makepkg` builds
origin `master`; these variables point it at this checkout's HEAD):

```sh
GHOST_SOURCE_REPO="file://$(git rev-parse --show-toplevel)" \
  GHOST_SOURCE_REF="commit=$(git rev-parse HEAD)" makepkg --cleanbuild
# CI uses a disposable native Arch root (requires arch-install-scripts and root):
sudo packaging/arch/arch-run.sh packaging/arch/build-native.sh
```

The chroot command expects, on ARM, the checksum-verified upstream Bun
binary at `.ci/bun/bun`. The workflow prepares these before invoking it.

## Owner-shared state

Shared notes, knowledge, decisions, plans, and tasks live in the owner's XDG
Documents directory. The ghost reads and writes it with its runtime's native
file tools; the package installs nothing there and gates nothing on it.

## Optional integrations

CLI integrations and product skills are yours to install from
upstream as the desktop user; the upstream installer then owns its files and
updates.

The package ships no skills: the `ghost` CLI is a ghost's documentation
(`ghost help products` indexes the recommended products, `ghost help browser`
the shared Chromium session and task tabs). Each product installs its own skill
(`<cli> skill install`). Machine skills are whatever each agent CLI discovers on
its own.

This remains the rolling, checkout-only development package: `pnpm install`
may populate its store during `build()`. The stable `ghost` package uses the
[v3 runtime-source mechanism](../release/README.md#reproducibility-boundary)
and also installs `/usr/bin/ghostd` and `/usr/bin/ghost`. Ghost publishes the
source and runtime inputs as a GitHub release (`../release/publish.sh`);
Omarchy's package repository carries `ghost` and owns the stable package
build and promotion (see [the release README](../release/README.md)).

Browser automation uses the optional agent-browser CLI through Bash. Ghost has
no screen control: desktop work goes through Omarchy's commands and app CLIs.

## Desktop boundary

The supported release target is Omarchy. There is no generic Arch/Hyprland
support promise. Packaging never edits `~/.config/hypr` or `~/.config/omarchy`.

## Upgrades, rollback, and uninstall

The package owns only files under `/usr`. It does not create or own `~/ghosts`,
`~/.config/ghost`, or `~/.local/state/ghost`. Upgrading or removing it therefore
leaves personas, documents, sessions, provider credentials, and API tokens
untouched.

An upgrade requires `systemctl --user restart ghostd.service` to load
the new bundle.
A package rollback uses the normal pacman cache
(`pacman -U /var/cache/pacman/pkg/<package>.pkg.tar.zst`) and likewise does not
roll back or delete user data. Ghost-home format changes must remain
forward/restart-safe under `CONTRACTS.md`; packaging does not invent a second
migration path.

To remove the complete checkout installation, stop and disable the user unit:

```sh
systemctl --user disable --now ghostd.service
sudo pacman -Rns ghost-dev
```

For the stable installation, use `sudo pacman -Rns ghost`.

That removes package-owned files only.

`smoke.sh <root>` validates the staged package tree, including daemon startup metadata,
the window and its desktop entry,
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
