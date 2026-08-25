# Stable Arch release source

This directory turns a tagged Ghost checkout into the two fixed inputs used by
the stable `ghost-ai` package:

1. `ghost-<version>.tar.gz`, deterministically generated from `v<version>`.
2. `ghost-runtime-<version>-linux-x86_64.tar.zst`, a self-contained daemon
   runtime built from the frozen pnpm lock and in-tree `pi-catalog` vendor.

The runtime archive is a package *source*, not an installed pacman package. It
is architecture-specific because the lock resolves native Linux/glibc x86-64
dependencies. QML, the desktop helper, browser extension, services, launchers,
licenses, and docs still come from the same tagged source archive, so a stable
package never mixes an old UI with a new daemon.

## Reproducibility boundary

Release CI first populates pnpm's content-addressed store. From that explicit
network boundary, `runtime-tree.sh` uses pnpm's offline mode, disables all
dependency lifecycle scripts, runs the repository's fixed TypeScript build,
and performs an offline production deploy. It forces a dependency
reconstruction from the store so a preceding development install cannot hide a
missing input. `onnxruntime-node`'s optional postinstall CUDA download is also
explicitly disabled and rejected from the payload; its bundled CPU runtime is
the portable release baseline. CI adds dead network proxies for defense in
depth. This is a package-manager/lifecycle offline guarantee, not a claim that
the hosted runner has a separate kernel network namespace. The archive records:

- the exact version, 40-character source commit, architecture, and commit time;
- SHA-256 for the root/workspace manifests, `pnpm-lock.yaml`, and every file in
  the vendored catalog;
- SHA-256 for every runtime file and every symlink target;
- the complete path/type/mode inventory.

The source archive carries its own version/commit/epoch manifest. Release CI
requires the event tag, its dereferenced commit, the checkout, the development
package source, the source manifest, and the runtime manifest to agree; the
source archive's fixed outer SHA-256 binds every helper, UI, extension, service,
and documentation byte to that identity. The runtime archive is emitted with
sorted paths, a fixed mtime, numeric root ownership,
normalized safe modes, single-threaded deterministic zstd output, and no link
to the checkout. `smoke-runtime-source.sh` extracts, verifies, and repacks it
byte-for-byte. Verification rejects special filesystem entries and exercises
the retained CPU ONNX, sharp, msgpackr-extract, Playwright, and Claude SDK x64
native/runtime surfaces. The stable PKGBUILD verifies both downloaded source archives by
fixed SHA-256, checks the internal manifests against the tagged checkout, and
performs `prepare()`, `build()`, `check()`, and `package()` without fetching.

Native upstream packages can still make a payload differ after a lock update;
that is why each release records and publishes the artifact checksum rather
than claiming that a different registry mirror can independently regenerate
identical upstream tarballs forever. Re-running the packer over the same staged
tree is byte-reproducible, and all staged bytes are traceable to fixed inputs.

## Release procedure

For an actual tag, the workflow performs the equivalent of:

```sh
version=0.1.0
commit="$(git rev-parse "v$version^{commit}")"
epoch="$(git show -s --format=%ct "$commit")"

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
`ghost-ai.install`. CI builds that package against local copies of the exact
sources with dead network proxies, extracts the pacman archive away from the
checkout, and applies the same closure/owner/mode/runtime smoke used by the
development package. That final archive smoke includes the retained native
runtime checks, and both recipes disable makepkg stripping of upstream prebuilt
ELF/addon assets. The rendered AUR bundle is also reproduced under umasks 022
and 077 and must remain byte-identical with normalized safe modes.

Publishing remains a deliberate human release action: create the version tag and
GitHub release, let CI attach the runtime source/checksum/AUR bundle, inspect the
release, then upload the rendered three-file bundle to the `ghost-ai` AUR
package. These scripts never create a tag, publish a release, or upload to AUR.

Generated archives and staging trees live under `packaging/release/out` and
`packaging/release/work`, which are ignored. The runtime is currently large;
keep both directories on a filesystem with several GiB free and remove them
after release validation.
