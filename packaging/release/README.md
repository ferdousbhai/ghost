# Release inputs for the Omarchy package

`publish.sh <version>` turns one exact Ghost source commit into the fixed
public inputs from which Omarchy builds the stable `ghost` package, builds
and signs the packages from those inputs, and publishes it all as a GitHub
release on `ferdousbhai/ghost`. Until Omarchy's repository carries the
package, the release is also the signed `[ghost]` pacman repository that
`curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash` adds and installs from
(see "Signed repository" below). The inputs:

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

Releases are cut from this machine, not from CI, and one command does the
whole thing:

```sh
packaging/release/publish.sh 0.1.1 --dry-run   # build, verify, render, sign; no tag
packaging/release/publish.sh 0.1.1             # bump, push, tag, publish, verify
```

`publish.sh` bumps the five manifests `verify-release-version.sh` reads when
they do not say the version yet and commits `release: <version>` (a dry run
does this too); a real run then pushes, and the `pre-push` hook runs the
whole gate. It builds the runtime and source archives with
`SOURCE_DATE_EPOCH` pinned to the commit, verifies the sanitized source and
the runtime smoke, writes `SHA256SUMS`, renders the stable `PKGBUILD`
through `render-arch-package.sh` and the Omarchy contribution through
[`../omarchy/render-contribution.sh`](../omarchy/render-contribution.sh),
builds and signs the packages ([`build-repo.sh`](build-repo.sh)), creates
the annotated tag, and publishes the GitHub release carrying:

- `install.sh`, the copy this release was verified with, which is what
  `https://ferdousbhai.com/ghost/install.sh` redirects to;
- `ghost-<version>.tar.gz`;
- `ghost-runtime-<version>-linux-any.tar.zst` and its `.sha256`;
- `SHA256SUMS`;
- the rendered `PKGBUILD` and both package install hooks;
- the signed repository: `ghost-runtime-<version>-1-any.pkg.tar.zst` and
  `ghost-<version>-1-any.pkg.tar.zst` with their `.sig`, `ghost.db` and
  `ghost.files` (plus `.tar.gz` forms) with their `.sig`, and
  `ghost-signing-key.asc`.

The installer itself is [`install.sh`](../../install.sh) at the repository
root. [`test-installer.sh`](test-installer.sh), which the gate runs, checks
its syntax, pins the hash of the `add_signed_repo` block it shares verbatim
with the icloud-notes installer, and holds the docs, the release notes and
`verify-published.sh` to one spelling of the public one-liner.

A release counts as shipped only once
[`verify-published.sh`](verify-published.sh) has run the public one-liner
in a clean Arch container and found this version installed; otherwise
`publish.sh` deletes the release and the tag. It then pushes the rendered
recipe to the omarchy-pkgs fork branch
([`update-omarchy-contribution.sh`](update-omarchy-contribution.sh)) so the
open pull request tracks the release.

The browser extension lives in its own repository; `PROTOCOL_VERSION` is the
only pin between it and a Ghost release.

## Signed repository

[`build-repo.sh`](build-repo.sh) builds both packages from the rendered
recipe with `makepkg`, using the archives beside it rather than the release
URLs (which do not exist yet), signs the packages and the database with the
key whose fingerprint [`package-signing-key.fingerprint`](package-signing-key.fingerprint)
pins, and writes `out/repo/`. That key lives only in the releasing machine's
keyring (its backup and rotation are described in the iCloud Notes README,
which shares the key: <https://github.com/ferdousbhai/icloud-notes#releasing>); `install.sh` pins the same fingerprint, downloads the
public key from the release, trusts it with `pacman-key`, writes
`/etc/pacman.d/ghost.conf` pointing at `releases/latest/download`, keeps it
across `omarchy refresh pacman` with a `pre-refresh-pacman` hook, and runs
`omarchy-pkg-add ghost`. Updates then arrive with `omarchy update`. When the
package lands in Omarchy's repository, that path takes over and the
repository assets can stop being published.

The contribution's `.omarchy/package.json` declares that release feed
(`upstream.github`, the runtime asset per architecture, and the source archive
URL), so omarchy-pkgs' `sync-upstream` rewrites `pkgver` and both checksum
arrays on its own when a newer `vX.Y.Z` tag appears. The rendered contribution
in `out/omarchy-ghost-<version>` is what goes into `pkgbuilds/ghost` of
[omacom/omarchy-pkgs](https://github.com/omacom/omarchy-pkgs); the menu
entries and install/remove scripts for the Omarchy repository itself are in
[`../omarchy/`](../omarchy/). Once the package is upstream, Omarchy builds,
signs, and promotes it through its `edge` → `rc` → `stable` channels, and the
signed repository above retires.

## After publishing

Two things do not follow the tag on their own:

- **Until omarchy-pkgs carries the package**, its pull request tracks the
  release: `publish.sh` pushes `out/omarchy-ghost-<version>` to
  `pkgbuilds/ghost` on the fork's `ghost` branch (`ferdousbhai/omarchy-pkgs`).
  If that push failed, do it by hand. Once the package is merged,
  `sync-upstream` does this for every later tag and this step disappears.
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
