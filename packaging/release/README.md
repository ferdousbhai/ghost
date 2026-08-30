# Stable Arch release source

This directory turns a tagged Ghost checkout into the two fixed inputs used by
the stable `ghost-ai` package:

1. `ghost-<version>.tar.gz`, deterministically generated from
   `v<version>`.
2. `ghost-runtime-<version>-linux-x86_64.tar.zst`, containing the compiled
   `ghostd` daemon and `ghost` terminal client built from the frozen pnpm
   workspace.

The v2 runtime archive is a package *source*, not an installed pacman package.
Its payload is exactly `bin/ghostd` and `bin/ghost`; Bun and the JavaScript
dependencies are compiled into those x86-64 executables. QML, the desktop
helper, browser extension, services, launchers, licenses, and docs still come
from the same tagged source archive, so a stable package never mixes an old UI
with a new daemon or client. Bun verifies that source at package build time; it
is not an installed runtime dependency.

## Reproducibility boundary

The v2 runtime archive contains `bin/ghostd` and `bin/ghost`, compiled by
`bun build --compile` at the `bun_version` recorded in `MANIFEST`, with
`compile_target=bun-linux-x64` and both payload checksums bound to the exact
`source_commit`. Release CI builds it from a frozen offline pnpm install behind
dead proxies; the stable package then verifies the archive's fixed checksum,
manifest, two-binary layout, executable x86-64 ELF files, and each binary's
`--help`/`--version` behavior before installation.

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
runtime source already contains the compiled daemon and terminal client. CI
builds that package against local copies of the exact sources with dead network
proxies, extracts the pacman archive away from the checkout, and applies the
same closure/owner/mode/runtime smoke used by the development package. Both
package recipes disable makepkg stripping of the compiled executables. The
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
