# Release inputs for the Omarchy package

`publish.sh <version>` turns one exact Ghost source commit into the fixed
public inputs from which Omarchy builds the stable `ghost` package, and
publishes them as a GitHub release on `ferdousbhai/ghost`:

1. `ghost-<version>.tar.gz`, a deterministic sanitized source snapshot;
2. `ghost-runtime-<version>-linux-any.tar.zst` (one archive for every Linux
   architecture Bun runs on; the payload has no native code), containing the ordinary
   Bun-target `ghostd` and `ghost` bundles, required static assets, fixed
   launchers, and exact bundled-package license closure; and
3. their checksums and release metadata.

The v3 runtime archive is a package *source*, not an installed pacman package.
Its payload contains `bin/ghostd`, `bin/ghost`, `lib/ghostd.js`, `lib/ghost.js`,
required static assets, and the exact licenses for the bundled application
closure. Ghost, pi, provider, and MCP support remain bundled for offline use;
the optional owner-installed Claude Agent SDK is excluded. QML, the desktop
helper, browser extension, services, launchers, licenses, and docs come from the
same sanitized source snapshot, so a stable package cannot mix an old UI with a
new daemon or client.

Installed launchers use `/usr/bin/bun`, so the stable `ghost` package and the
checkout-only `ghost-dev` recipe require system Bun 1.3.14 or newer. The current
build/check toolchain requires Bun 1.4.0 or newer. Both recipes also depend on
system `fd` and `ripgrep` for pi's native `find` and `grep`. This prevents a
read-only planning turn from downloading search tools into pi's cache.

## Reproducibility boundary

The v3 runtime archive records `bun_build_version` separately from
`bun_runtime_min`, fixes `bundle_target=bun`, and binds every launcher, bundle,
license, and license-manifest byte to the exact `source_commit` through
`PAYLOAD.SHA256`. The stable recipe verifies the source/runtime checksums, exact
layout and modes, payload and bundled-license closure, Agent SDK exclusion,
declared/current Bun compatibility, and both launchers' `--help`/`--version`
plus scratch-daemon behavior before installation.

## Cutting a release

Releases are cut from this machine, not from CI. On a pushed, clean `master`
whose manifests already carry the version (`verify-release-version.sh`):

```sh
packaging/release/publish.sh 0.1.0 --dry-run   # build, verify, render; no tag
packaging/release/publish.sh 0.1.0             # tag v0.1.0 and publish
```

The script builds the runtime and source archives with `SOURCE_DATE_EPOCH`
pinned to the commit, verifies the sanitized source and the runtime smoke,
writes `SHA256SUMS`, renders the stable `PKGBUILD` through
`render-arch-package.sh` and the Omarchy contribution through
[`../omarchy/render-contribution.sh`](../omarchy/render-contribution.sh), then
creates the annotated tag and the GitHub release carrying:

- `ghost-<version>.tar.gz`;
- `ghost-runtime-<version>-linux-any.tar.zst` and its `.sha256`;
- `SHA256SUMS`.

The contribution's `.omarchy/package.json` declares that release feed
(`upstream.github`, the runtime asset per architecture, and the source archive
URL), so omarchy-pkgs' `sync-upstream` rewrites `pkgver` and both checksum
arrays on its own when a newer `vX.Y.Z` tag appears. The rendered contribution
in `out/omarchy-ghost-<version>` is what goes into `pkgbuilds/ghost` of
[omacom/omarchy-pkgs](https://github.com/omacom/omarchy-pkgs); the menu
entries and install/remove scripts for the Omarchy repository itself are in
[`../omarchy/`](../omarchy/). Ghost does not operate a pacman repository or
package-signing key: Omarchy builds, signs, and promotes the package through
its `edge` → `rc` → `stable` channels.

`ghost-dev` remains the checkout-only rolling recipe under
[`../arch/`](../arch/). It provides and conflicts with `ghost` so the two
cannot be installed together. Generated archives and work trees live under
`out/` and `work/`, which are ignored.
