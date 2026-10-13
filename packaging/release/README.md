# Release inputs for the Omarchy package

`publish.sh <version>` turns one exact Ghost source commit into the fixed
public inputs from which Omarchy builds the stable `ghost` package, and
publishes them as a GitHub release on `ferdousbhai/ghost`. Omarchy's package
repository carries `ghost`: its recipe (`pkgbuilds/ghost` in
[omacom/omarchy-pkgs](https://github.com/omacom/omarchy-pkgs)) downloads these
inputs from the release, and its `sync-upstream` workflow follows the tags.
The inputs:

1. `ghost-<version>.tar.gz`, a deterministic sanitized source snapshot;
2. `ghost-runtime-<version>-linux-any.tar.zst` (one archive for every Linux
   architecture Bun runs on; the payload has no native code), containing the ordinary
   Bun-target `ghostd` and `ghost` bundles, required static assets, fixed
   launchers, and exact bundled-package license closure; and
3. their checksums and release metadata.

The stable recipe builds `ghost-runtime` and `ghost` from the same inputs.
`ghost` contains only the Omarchy UI and depends on the exact runtime version;
`ghost-runtime` is independently installable for apps with their own UI (see
[the install choices](../arch/README.md#runtime-with-your-own-ui)).

The v3 runtime archive is a package *source*, not an installed pacman package.
Its payload contains `bin/ghostd`, `bin/ghost`, `lib/ghostd.js`, `lib/ghost.js`,
required static assets, and the exact licenses for the bundled application
closure. Ghost and its MCP support remain bundled for offline use.
Bundles are minified with function and class names preserved for diagnostics;
the full license closure stays in the payload.
QML, the desktop
helper, browser extension, services, launchers, licenses, and docs come from the
same sanitized source snapshot, so a stable package cannot mix an old UI with a
new daemon or client.

Installed launchers use `/usr/bin/bun`, so the stable `ghost-runtime` package and the
checkout-only `ghost-runtime-dev` recipe require system Bun 1.3.14 or newer. The current
build/check toolchain requires Bun 1.4.0 or newer.

## Reproducibility boundary

The v3 runtime archive records `bun_build_version` separately from
`bun_runtime_min`, fixes `bundle_target=bun`, and binds every launcher, bundle,
license, and license-manifest byte to the exact `source_commit` through
`PAYLOAD.SHA256`. The stable recipe verifies the source/runtime checksums, exact
layout and modes, payload and bundled-license closure, Agent SDK exclusion,
declared/current Bun compatibility, and both launchers' `--help`/`--version`
plus scratch-daemon behavior before installation.

## Cutting a release

Releases are cut from this machine, not from CI, and one command does the
whole thing:

```sh
packaging/release/publish.sh 0.1.1 --dry-run   # build, verify, build the packages; no tag
packaging/release/publish.sh 0.1.1             # bump, push, tag, publish
```

`publish.sh` bumps the five manifests `verify-release-version.sh` reads when
they do not say the version yet and commits `release: <version>` (a dry run
does this too); a real run then pushes, and the `pre-push` hook runs the
whole gate. It builds the runtime and source archives with
`SOURCE_DATE_EPOCH` pinned to the commit, verifies the sanitized source and
the runtime smoke, writes `SHA256SUMS`, renders the stable `PKGBUILD`
through `render-arch-package.sh` and builds both packages from it with
`makepkg`, using the archives beside it rather than the release URLs (which
do not exist yet), creates the annotated tag, and publishes the GitHub
release carrying:

- `install.sh`, which is what `https://ferdousbhai.com/ghost/install.sh`
  redirects to;
- `ghost-<version>.tar.gz`;
- `ghost-runtime-<version>-linux-any.tar.zst` and its `.sha256`;
- `SHA256SUMS`.

The installer itself is [`install.sh`](../../install.sh) at the repository
root: on Omarchy it runs `omarchy-install-ai-ghost` when Omarchy ships it,
and otherwise installs the `ghost` package from Omarchy's repository with
`omarchy-pkg-add` and starts it for this login.
[`test-installer.sh`](test-installer.sh), which the gate runs, checks its
syntax and holds the docs and the release notes to one spelling of the
public one-liner.

The browser extension lives in its own repository; `PROTOCOL_VERSION` is the
only pin between it and a Ghost release.

## Omarchy's recipe

The rendered contribution
([`../omarchy/render-contribution.sh`](../omarchy/render-contribution.sh)) is
what went into `pkgbuilds/ghost` of omarchy-pkgs; its `.omarchy/package.json`
declares this release feed (`upstream.github`, the runtime asset, and the
source archive URL), so `sync-upstream` rewrites `pkgver` and both checksum
arrays on its own when a newer `vX.Y.Z` tag appears, and Omarchy builds,
signs, and promotes the package through its `edge` → `rc` → `stable`
channels. [`../omarchy/test-contribution.sh`](../omarchy/test-contribution.sh)
models that rewrite. A change to the recipe template here is a change to
propose upstream, by hand; the menu entries and install/remove scripts for
the Omarchy repository itself are in [`../omarchy/`](../omarchy/).

## After publishing

Omarchy's `sync-upstream` picks the release up; nothing is pushed to
omarchy-pkgs. One thing does not follow the tag on its own:

- **A checkout install** is the owner's to pull, build, and restart; follow
  [`../../docs/self-maintenance.md`](../../docs/self-maintenance.md). Ghost
  does not poll for releases.

`ghost-dev` remains the checkout-only rolling recipe under
[`../arch/`](../arch/). It provides and conflicts with `ghost` so the two
cannot be installed together. Generated archives and work trees live under
`out/` and `work/`, which are ignored.
