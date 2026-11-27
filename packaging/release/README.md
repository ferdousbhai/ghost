# The release input for the Omarchy package

`publish.sh <version>` turns one exact Ghost source commit into the input
from which Omarchy builds the stable `ghost` package, and publishes it as a
GitHub release on `ferdousbhai/ghost`. Omarchy's package repository carries
`ghost`: its recipe (`pkgbuilds/ghost` in
[omacom/omarchy-pkgs](https://github.com/omacom/omarchy-pkgs)) downloads the
release's `ghost-<version>.tar.gz`, a deterministic source snapshot,
and its `sync-upstream` workflow follows the tags.

The recipe builds everything from that snapshot: `prepare()` downloads what
cargo's lockfile names, and `build()` compiles the daemon, the `ghost`
command and the bar with cargo. One archive, one commit: a package cannot
mix an old bar with a new daemon or client.

## Cutting a release

Releases are cut from this machine, not from CI, and one command does the
whole thing:

```sh
packaging/release/publish.sh 0.1.1 --dry-run   # build, verify, build the packages; no tag
packaging/release/publish.sh 0.1.1             # bump, push, tag, publish
```

`publish.sh` bumps the version in the root `Cargo.toml` when
it does not say the version yet and commits `release: <version>` (a dry run
does this too); a real run then pushes, and the `pre-push` hook runs the
whole gate. It builds the source archive with
`git archive`, writes `SHA256SUMS`, renders the stable `PKGBUILD`
through `render-arch-package.sh` and builds the package from it with
`makepkg`, using the archive beside it rather than the release URL (which
does not exist yet), creates the annotated tag, and publishes the GitHub
release carrying:

- `ghost-<version>.tar.gz`;
- `SHA256SUMS`, for checking a download by hand (Omarchy's sync uses
  GitHub's own asset digests);
- `ghost-recipe.tar.gz` (Omarchy's `pkgbuilds/ghost` rendered for this
  release), `install.sh` and `omarchy-install-ai-ghost`: what
  `ferdousbhai.com/ghost/install.sh`, a redirect to the latest release's
  `install.sh`, runs for an owner ahead of Omarchy's sync. It installs the
  same package: from Omarchy's repository when that has the latest release,
  else built with makepkg from the recipe, never from a second package
  repository, so `omarchy update` carries on from there.
  [`test-install-script.sh`](test-install-script.sh) checks its choices.

Users install the `ghost` package from Omarchy's repository.
[`omarchy-install-ai-ghost`](../omarchy/bin/omarchy-install-ai-ghost) is the
step proposed for Omarchy's Install → AI menu
([#54](https://github.com/ferdousbhai/ghost/issues/54)), and the one
`install.sh` ends with: it installs the package and starts ghostd for this
login, whose first start makes the ghost home.

## Omarchy's recipe

The recipe [`render-arch-package.sh`](render-arch-package.sh) renders is
what went into `pkgbuilds/ghost` of omarchy-pkgs; its `.omarchy/package.json`
declares this release feed (`upstream.github` and the release's source archive,
checked against GitHub's digest), so `sync-upstream` rewrites `pkgver` and
the checksum on its own when a newer `vX.Y.Z` release appears, and
Omarchy builds, signs, and promotes the package through its `edge` → `rc` →
`stable` channels. Ghost is not in sync-upstream's hourly lane: its feed is
checked every six hours, and it takes the latest release only, so a release
published between two checks waits for the next, and one superseded before
it is skipped. [`../omarchy/test-contribution.sh`](../omarchy/test-contribution.sh)
models that rewrite. A change to the recipe template here is a change to
propose upstream, by hand; the menu entries and install/remove scripts for
the Omarchy repository itself are in [`../omarchy/`](../omarchy/).

## After publishing

Nothing is pushed to omarchy-pkgs for a release. Within six hours its
`sync-upstream` bumps `pkgbuilds/ghost` to the release, and owners get it
from `omarchy update` once Omarchy has built and promoted it; that schedule
is Omarchy's, not the release's. Meanwhile the release's `install.sh`
(`curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash`) builds it from
`ghost-recipe.tar.gz`. Two things do not follow the tag on their own:

- **Recipe changes.** The sync rewrites only the version and checksums. A
  change to the recipe itself (dependencies, descriptions, install
  messages, the feed) is a pull request to omarchy-pkgs rendered from
  [`../omarchy/`](../omarchy/), reviewed by Omarchy's maintainers.
- **A checkout install** is the owner's to pull, build, and restart; follow
  [`../../docs/self-maintenance.md`](../../docs/self-maintenance.md). Ghost
  does not poll for releases.

The packaging checks are [`../check.sh`](../check.sh), which the gate and the
recipe's `check()` run; `check()` calls it by the path the 0.13.0 archive has,
[`../arch/test-check-dependencies.sh`](../arch/test-check-dependencies.sh), so
one recipe builds that release and later ones. The `Native packages` workflow
builds this recipe, tests included, from the commit's own source archive, in
clean Arch Linux x86_64 and Arch Linux ARM aarch64 roots, on every master
push (`sudo packaging/arch/arch-run.sh packaging/arch/build-native.sh`).
Generated archives and work trees live under
`out/` and `work/`, which are ignored.
