# Stable Omarchy release inputs

> **RELEASE HOLD:** these scripts and examples are prospective. Do not create a
> tag or release repository, stage or publish a release, submit an Omarchy
> contribution, or install on the owner's live machine until the owner lifts
> the hold and #17 is complete for the exact candidate.

This directory turns one exact Ghost source commit into the fixed public inputs
from which Omarchy can build the stable `ghost` package:

1. `ghost-<version>.tar.gz`, a deterministic sanitized source snapshot;
2. `ghost-runtime-<version>-linux-x86_64.tar.zst`, containing the ordinary
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
`PAYLOAD.SHA256`. Release CI builds it from a frozen offline pnpm install behind
dead proxies. The stable recipe verifies the source/runtime checksums, exact
layout and modes, payload and bundled-license closure, Agent SDK exclusion,
declared/current Bun compatibility, and both launchers' `--help`/`--version`
plus scratch-daemon behavior before installation.

CI separately downloads official Linux x64 Bun 1.3.14, verifies its pinned
SHA-256 and exact version, and repeats the runtime's launcher and scratch
daemon/client smoke through that minimum executable. Before constructing
artifacts, CI requires the root, daemon, extensions, shell, Chromium package,
and Chromium extension manifest to carry one canonical, nonzero,
three-component version. The desktop helper keeps its independent version.

Before any candidate upload, CI also installs the exact optional Claude Agent
SDK graph from the already-populated pnpm store into a private scratch
owner-data root. It loads that real graph through Ghost's production Bun
loader, removes it, and verifies that the loader fails closed until daemon
restart. The check never starts Claude Code, contacts a provider, or inspects
owner authentication; authenticated principal turns remain a
manual release check.

## Prospective local rendering example

The renderer takes four positional arguments and requires the public release
repository through the environment. The following is a prospective shape, not
a release command to run while the hold is active:

```sh
export GHOST_RELEASE_REPOSITORY=ferdousbhai/ghost-releases
version=0.1.0
commit="$(git rev-parse 'HEAD^{commit}')"
epoch="$(git show -s --format=%ct "$commit")"
out=packaging/release/out

packaging/release/prepare-pnpm-engine.sh .
pnpm fetch --frozen-lockfile
SOURCE_DATE_EPOCH="$epoch" \
  packaging/release/build-runtime-source.sh \
    . "$out" "$version" x86_64 "$commit"
SOURCE_DATE_EPOCH="$epoch" \
  packaging/release/make-source-archive.sh \
    . "$out/ghost-$version.tar.gz" "$version" HEAD

source_sha="$(sha256sum "$out/ghost-$version.tar.gz" | cut -d' ' -f1)"
runtime_sha="$(sha256sum \
  "$out/ghost-runtime-$version-linux-x86_64.tar.zst" | cut -d' ' -f1)"
packaging/release/render-arch-package.sh \
  "$out/ghost-$version" "$version" "$source_sha" "$runtime_sha"
packaging/omarchy/render-contribution.sh \
  "$out/omarchy-ghost-$version" "$version" "$source_sha" "$runtime_sha"
```

`render-arch-package.sh` produces the stable `ghost` `PKGBUILD`, `.SRCINFO`,
and `ghost.install` used by CI's offline package proof. The Omarchy renderer
produces the contribution shape Omarchy expects: `PKGBUILD`, `ghost.install`,
and `.omarchy/` metadata. It is not a package publication and neither renderer
creates a tag, release, package repository, signing key, or remote submission.

The stable recipe conflicts with `ghost-dev`; the development recipe provides
and conflicts with `ghost`. Only one can own `/usr/bin/ghost` and the installed
services at a time.

## Public candidate

When the repository-level `GHOST_RELEASE_REPOSITORY` variable is configured,
the Arch workflow places the publishable subset in
`$GHOST_CI_RELEASE_OUT/public-candidate`. Without that variable, ordinary CI
still verifies the deterministic source and runtime but creates and uploads no
destination-bound candidate. The canonical interface is
`public-candidate-interface.json`; creation and verification are handled by
`public-candidate.py`. Its exact inventory is:

- `ghost-<version>.tar.gz`;
- `ghost-runtime-<version>-linux-x86_64.tar.zst`;
- `ghost-runtime-<version>-linux-x86_64.tar.zst.sha256`;
- `RELEASE-METADATA.json`;
- `SHA256SUMS`; and
- optional detached `SHA256SUMS.sig`.

The candidate excludes every `.pkg.tar.zst` and every `ghost-dev-*` artifact.
Ghost does not operate a pacman repository or package-signing key. Omarchy owns
the stable package build, signature, repository, review, and promotion.

The private workflow that can verify, stage, and publish this candidate is
documented in
[`docs/release-publication.md`](../../docs/release-publication.md). The release
hold applies to every remote mode. Generated archives and staging trees live
under `packaging/release/out` and `packaging/release/work`, which are ignored.
