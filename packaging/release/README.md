# Stable Arch release source

This directory turns a tagged Ghost checkout into the two fixed inputs used by
the stable `ghost-ai` package:

1. `ghost-<version>.tar.gz`, deterministically generated from
   `v<version>`.
2. `ghost-runtime-<version>-linux-x86_64.tar.zst`, containing the compiled
   `ghostd` executable built from the frozen pnpm workspace.

The v2 runtime archive is a package *source*, not an installed pacman package.
Its payload is exactly `bin/ghostd`; Bun and the daemon's JavaScript
dependencies are compiled into that x86-64 executable. QML, the desktop helper,
browser extension, services, launchers, licenses, and docs still come from the
same tagged source archive, so a stable package never mixes an old UI with a
new daemon.

## Reproducibility boundary

Release CI verifies the repository's pnpm engine and populates pnpm's
content-addressed store before closing the network boundary.
`build-runtime-source.sh` then forces a frozen offline install from that
store, disables dependency lifecycle scripts, runs the repository build, and
invokes the daemon's `bun build --compile` recipe. Reconstructing dependencies
means a preceding development install cannot hide a missing input.
`ONNXRUNTIME_NODE_INSTALL=skip` and `--ignore-scripts` prevent dependency
installers from downloading optional native payloads. CI also supplies dead
network proxies for defense in depth. This is a package-manager/lifecycle
offline guarantee, not a claim that the hosted runner has a separate kernel
network namespace.

The archive records:

- the exact version, 40-character source commit, architecture, and commit time;
- SHA-256 for the root and every workspace `package.json`,
  `pnpm-workspace.yaml`, `pnpm-lock.yaml`, an optional root `.npmrc`, and
  `packages/daemon/scripts/build-binary.sh`;
- SHA-256 and the normalized mode inventory for `bin/ghostd`.

The source archive carries its own version/commit/epoch manifest. Release CI
requires the event tag, its dereferenced commit, the checkout, the development
package source, the source manifest, and the runtime manifest to agree. The
source archive's fixed outer SHA-256 binds every build helper, UI, extension,
service, and documentation byte to that identity.

The runtime archive is emitted with sorted paths, a fixed mtime, numeric root
ownership, normalized safe modes, and single-threaded deterministic zstd
output. `smoke-runtime-source.sh` extracts, verifies, and repacks it
byte-for-byte. Verification requires the exact v2 layout, recomputes the frozen
input and payload manifests, rejects special entries, checks that
`bin/ghostd` is an executable x86-64 ELF, and runs its `--help` and
`--version` paths with the release CI network-blocking environment. The
stable PKGBUILD verifies both downloaded source archives by fixed SHA-256,
checks their internal manifests against the tagged checkout, and performs
`prepare()`, `build()`, `check()`, and `package()` without fetching.

Compiler or dependency updates can still change the binary; that is why each
release records and publishes the artifact checksum rather than claiming that
a different toolchain can regenerate identical bytes forever. Repacking the
same staged tree is byte-reproducible, and all staged bytes are traceable to
fixed inputs.

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
runtime source already contains the compiled daemon. CI builds that package
against local copies of the exact sources with dead network proxies, extracts
the pacman archive away from the checkout, and applies the same
closure/owner/mode/runtime smoke used by the development package. Both package
recipes disable makepkg stripping of the compiled executable. The rendered AUR
bundle is also reproduced under umasks 022 and 077 and must remain
byte-identical with normalized safe modes.

Publishing remains a deliberate human release action: create the version tag
and GitHub release, let CI attach the runtime source/checksum/AUR bundle,
inspect the release, then upload the rendered three-file bundle to the
`ghost-ai` AUR package. These scripts never create a tag, publish a release,
or upload to AUR.

Generated archives and staging trees live under `packaging/release/out` and
`packaging/release/work`, which are ignored. Remove them after release
validation.
