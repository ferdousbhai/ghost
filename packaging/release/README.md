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

The stable recipe builds `ghost-runtime` and `ghost` from the same inputs.
`ghost` contains only the Omarchy UI and depends on the exact runtime version;
`ghost-runtime` is independently installable for apps with their own UI (see
[the install choices](../arch/README.md#runtime-with-your-own-ui)).

The v3 runtime archive is a package *source*, not an installed pacman package.
Its payload contains `bin/ghostd`, `bin/ghost`, `lib/ghostd.js`, `lib/ghost.js`,
required static assets, and the exact licenses for the bundled application
closure. Ghost, pi, provider, and MCP support remain bundled for offline use.
Bundles are minified with function and class names preserved for diagnostics;
Photon's image-processing WASM and the full license closure stay in the payload.
The source archive includes the pinned Pi patch described in
[`CONTRACTS.md`](../../CONTRACTS.md#pi). Pi upgrades must keep
`test/pi-extension-loading.test.ts` and `test/session-host.test.ts` passing and
recheck the bundled runtime; the patch removes the unused file-extension loader,
not Ghost's inline factories.
QML, the desktop
helper, browser extension, services, launchers, licenses, and docs come from the
same sanitized source snapshot, so a stable package cannot mix an old UI with a
new daemon or client.

Installed launchers use `/usr/bin/bun`, so the stable `ghost-runtime` package and the
checkout-only `ghost-runtime-dev` recipe require system Bun 1.3.14 or newer. The current
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

Releases are cut from this machine, not from CI. Bump the seven manifests
`verify-release-version.sh` reads, commit as `release: <version> — <one line>`,
push (the `pre-push` hook runs the whole gate), then publish:

```sh
old=0.1.0; new=0.1.1
# The browser extension lives in its own repository; PROTOCOL_VERSION is the
# only pin between it and a Ghost release.
sed -i "s/\"version\": \"$old\"/\"version\": \"$new\"/" package.json \
  packages/{daemon,extensions,shell}/package.json packages/shell/qml/manifest.json
packaging/release/verify-release-version.sh .    # prints the one version they all say
packaging/release/publish.sh 0.1.1 --dry-run     # build, verify, render; no tag
packaging/release/publish.sh 0.1.1               # tag v0.1.1 and publish
```

The script builds the runtime and source archives with `SOURCE_DATE_EPOCH`
pinned to the commit, verifies the sanitized source and the runtime smoke,
writes `SHA256SUMS`, renders the stable `PKGBUILD` through
`render-arch-package.sh` and the Omarchy contribution through
[`../omarchy/render-contribution.sh`](../omarchy/render-contribution.sh), then
creates the annotated tag and the GitHub release carrying:

- `ghost-<version>.tar.gz`;
- `ghost-runtime-<version>-linux-any.tar.zst` and its `.sha256`;
- `SHA256SUMS`;
- the rendered `PKGBUILD` and both package install hooks.

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

## After publishing

Two things do not follow the tag on their own:

- **Until omarchy-pkgs carries the package**, its pull request tracks the
  release by hand. The fork's branch is `ferdousbhai/omarchy-pkgs` `ghost`;
  replace `pkgbuilds/ghost` there with `out/omarchy-ghost-<version>`, commit
  `ghost: <version>`, push. Once the package is merged, `sync-upstream` does
  this for every later tag and this step disappears.
- **A checkout install** (`~/.local/bin/ghostd` pointing at a clone, see
  [`../../docs/self-maintenance.md`](../../docs/self-maintenance.md)) is
  updated by the command `ghost status` prints on its `update` line: a
  fast-forward pull, `pnpm install --frozen-lockfile`, `pnpm build`, a daemon
  restart, and `omarchy-restart-shell`. The daemon checks for releases at boot and daily,
  so the line appears within a day, or at once after a daemon restart.

`ghost-dev` remains the checkout-only rolling recipe under
[`../arch/`](../arch/). It provides and conflicts with `ghost` so the two
cannot be installed together. Generated archives and work trees live under
`out/` and `work/`, which are ignored.
