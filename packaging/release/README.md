# Stable Arch release source

This directory turns a tagged Ghost checkout into the two fixed inputs used by
the stable `ghost-ai` package:

1. `ghost-<version>.tar.gz`, deterministically generated from
   `v<version>`.
2. `ghost-runtime-<version>-linux-x86_64.tar.zst`, containing ordinary
   Bun-target `ghostd` and `ghost` bundles, their required static assets, fixed
   launchers, and exact bundled-package license closure built from the frozen
   pnpm workspace.

The v3 runtime archive is a package *source*, not an installed pacman package.
Its payload contains `bin/ghostd`, `bin/ghost`, `lib/ghostd.js`, `lib/ghost.js`,
required static assets, and the exact licenses for the bundled application closure. Ghost, pi,
providers, and MCP support remain bundled for offline use; the optional Claude
Agent SDK does not enter either bundle or the runtime payload. QML, the desktop
helper, browser extension, services, launchers, licenses, and docs still come
from the same tagged source archive, so a stable package never mixes an old UI
with a new daemon or client. The installed launchers use `/usr/bin/bun`, so both
stable and development packages declare Bun 1.3.14 or newer as a runtime
dependency. They also declare `fd` and `ripgrep` for pi's native `find` and
`grep`; shipping those binaries prevents pi from downloading them into its
cache during an otherwise read-only planning turn.

## Reproducibility boundary

The v3 runtime archive records `bun_build_version` separately from
`bun_runtime_min`, fixes `bundle_target=bun`, and binds every launcher, bundle,
license, and license-manifest byte to the exact `source_commit` through
`PAYLOAD.SHA256`. Release CI builds it from a frozen offline pnpm install behind
dead proxies; the stable package then verifies the archive checksum, exact
layout and modes, full payload closure, bundled-license closure, exclusion of
Claude Agent SDK bytes, declared/current Bun compatibility, and both launchers'
`--help`/`--version` plus scratch-daemon behavior before installation. After the
real archive is built and before artifacts are sealed, a separate gate downloads
the official Linux x64 Bun 1.3.14 asset, verifies the hard-coded SHA-256 and exact
reported version, and repeats the archive's full launcher and scratch
daemon/client smoke through that executable. Before constructing those
artifacts, CI also requires the root, daemon, extensions, shell, Chromium package,
and Chromium extension manifest to carry one canonical three-component numeric
release version that is valid in the browser manifest. The desktop helper keeps
its independent protocol/package version.

## Release procedure

For an actual tag, the workflow performs the equivalent of:

```sh
version=0.1.0
commit="$(git rev-parse "v$version^{commit}")"
epoch="$(git show -s --format=%ct "$commit")"

packaging/release/prepare-pnpm-engine.sh .
pnpm fetch --frozen-lockfile
SOURCE_DATE_EPOCH="$epoch" \
  packaging/release/build-runtime-source.sh \
  . packaging/release/out "$version" x86_64 "$commit"

SOURCE_DATE_EPOCH="$epoch" \
  packaging/release/make-source-archive.sh \
  . "packaging/release/out/ghost-$version.tar.gz" "$version" "v$version"

packaging/release/render-arch-package.sh \
  "packaging/release/out/ghost-ai-$version-aur" \
  "$version" "$commit" "$epoch" \
  "$(sha256sum "packaging/release/out/ghost-$version.tar.gz" | cut -d' ' -f1)" \
  "$(sha256sum "packaging/release/out/ghost-runtime-$version-linux-x86_64.tar.zst" | cut -d' ' -f1)"
```

The rendered directory contains the AUR-ready `PKGBUILD`, `.SRCINFO`, and
`ghost-ai.install`. Its `build()` is deliberately a no-op: the downloaded
runtime source already contains the bundled daemon and terminal client. CI
builds that package against local copies of the exact sources with dead network
proxies, extracts the pacman archive away from the checkout, and applies the
same closure/owner/mode/runtime smoke used by the development package. Both
package recipes disable makepkg stripping because the runtime source is already
verified byte-for-byte. The
rendered AUR bundle is also reproduced under umasks 022 and 077 and must remain
byte-identical with normalized safe modes.

Publishing remains a deliberate human release action: create the version tag
and GitHub release, let CI attach the runtime source/checksum/AUR bundle,
inspect the release, then upload the rendered three-file bundle to the
`ghost-ai` AUR package. These scripts never create a tag, publish a release,
or upload to AUR.

Generated archives and staging trees live under `packaging/release/out` and
`packaging/release/work`, which are ignored. Remove them after release
validation.
