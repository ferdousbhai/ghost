#!/usr/bin/env bash
# Cut a Ghost release from this machine: build the source and runtime archives,
# verify them, tag the commit, and publish a GitHub release on
# ferdousbhai/ghost (GHOST_RELEASE_REPOSITORY to override). Omarchy's
# package repository builds the `ghost` package from that release: its
# sync-upstream workflow follows the tags and rewrites the recipe's pkgver and
# checksums on its own.
#
#   packaging/release/publish.sh <version> [--dry-run]
#
# If the manifests do not say <version> yet, it bumps them, commits
# `release: <version>` and pushes (the pre-push hook runs the gate).
#
# --dry-run bumps the version if needed, then builds, verifies and builds the
# packages from the committed tree and stops before the push, tag and release.
set -euo pipefail

usage='publish.sh <version> [--dry-run]'
version="${1:?usage: $usage}"
dry_run=0
# Anything but exactly --dry-run is refused: a typo must not publish.
case "$#:${2-}" in
  1:) ;;
  2:--dry-run) dry_run=1 ;;
  *) printf 'usage: %s\n' "$usage" >&2; exit 1 ;;
esac

script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_root/../..")"
repository="${GHOST_RELEASE_REPOSITORY:-ferdousbhai/ghost}"
out="$script_root/out"
tag="v$version"

cd -- "$source_root"
[[ "$(git rev-parse --abbrev-ref HEAD)" == master ]] || {
  printf 'release from master, not %s\n' "$(git rev-parse --abbrev-ref HEAD)" >&2
  exit 1
}
[[ -z "$(git status --porcelain)" ]] || {
  printf 'the tree is dirty; commit or drop the changes first\n' >&2
  exit 1
}
if (( ! dry_run )) && git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
  printf 'tag %s already exists\n' "$tag" >&2
  exit 1
fi
# Before anything is committed or pushed: a release ends in `gh release`.
(( dry_run )) || gh auth status >/dev/null
# The version lives in several manifests; a release starts by making them agree.
current="$(bash "$script_root/verify-release-version.sh" "$source_root")"
if [[ "$current" != "$version" ]]; then
  # Refused before any manifest is touched, so a typo leaves a clean tree.
  bash "$script_root/verify-release-version.sh" --valid "$version"
  mapfile -t manifests < <(bash "$script_root/verify-release-version.sh" --manifests)
  for manifest in "${manifests[@]}"; do
    sed -i "s/\"version\": \"$current\"/\"version\": \"$version\"/" "$manifest"
  done
  bash "$script_root/verify-release-version.sh" "$source_root" | grep -Fxq "$version" || {
    printf 'the manifests still do not all say %s after the bump\n' "$version" >&2
    exit 1
  }
  git commit -q -am "release: $version"
  printf 'bumped %s -> %s\n' "$current" "$version"
fi
if (( ! dry_run )); then
  git fetch -q origin master
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse origin/master)" ]]; then
    git merge-base --is-ancestor origin/master HEAD || {
      printf 'HEAD has diverged from origin/master; pull first\n' >&2
      exit 1
    }
    git push origin master # the pre-push hook runs the gate
  fi
fi
commit="$(git rev-parse 'HEAD^{commit}')"
epoch="$(git show -s --format=%ct "$commit")"
work="$script_root/work"
rm -rf -- "$out" "$work"
mkdir -p -- "$out" "$work"

bash "$script_root/prepare-pnpm-engine.sh" "$source_root"
pnpm fetch --frozen-lockfile
SOURCE_DATE_EPOCH="$epoch" GHOST_RELEASE_WORK_ROOT="$work" \
  bash "$script_root/build-runtime-source.sh" \
    "$source_root" "$out" "$version" any "$commit"
SOURCE_DATE_EPOCH="$epoch" \
  bash "$script_root/make-source-archive.sh" \
    "$source_root" "$out/ghost-$version.tar.gz" "$version" HEAD
# The verifier reads the sanitized archive, not this tree.
tar -xf "$out/ghost-$version.tar.gz" -C "$work"
bash "$script_root/verify-release-source.sh" "$work/ghost-$version" "$version" "$commit" "$epoch"
GHOST_RELEASE_WORK_ROOT="$work" \
  bash "$script_root/smoke-runtime-source.sh" \
    "$out/ghost-runtime-$version-linux-any.tar.zst" \
    "$source_root" "$version" any "$commit" "$epoch"
rm -rf -- "$work"
(cd -- "$out" && sha256sum -- "ghost-$version.tar.gz" "ghost-runtime-$version-linux-any.tar.zst" > SHA256SUMS)

source_sha="$(sed -n 1p "$out/SHA256SUMS" | cut -d' ' -f1)"
runtime_sha="$(sed -n 2p "$out/SHA256SUMS" | cut -d' ' -f1)"
bash "$script_root/smoke-rendered-package.sh" "$version" "$source_sha" "$runtime_sha"
# Omarchy's recipe is the one rendered here (pkgbuilds/ghost in
# omacom/omarchy-pkgs); building it from the archives beside it, rather than
# the release URLs that do not exist yet, proves the release builds there.
mkdir -p -- "$work"
build="$(mktemp -d "$work/package-build.XXXXXX")"
bash "$script_root/render-arch-package.sh" "$build/ghost" "$version" "$source_sha" "$runtime_sha"
cp -- "$out/ghost-$version.tar.gz" "$out/ghost-runtime-$version-linux-any.tar.zst" "$build/ghost/"
(
  cd -- "$build/ghost"
  LC_ALL=C PKGDEST="$build/pkg" PKGEXT=.pkg.tar.zst makepkg --force
)
rm -rf -- "$work"

printf '\nrelease inputs for %s %s (%s):\n' "$repository" "$tag" "$commit"
cat -- "$out/SHA256SUMS"
if (( dry_run )); then
  printf '\ndry run: no tag, no release. Release inputs: %s\n' "$out"
  exit 0
fi

git tag -a "$tag" -m "ghost $version" "$commit"
git push origin "$tag"
gh release create "$tag" \
  --repo "$repository" \
  --title "ghost $version" \
  --notes "Install on Omarchy: \`omarchy pkg add ghost\`, from Omarchy's package repository. These are the source and runtime inputs Omarchy builds that package from." \
  -- \
  "$out/ghost-$version.tar.gz" \
  "$out/ghost-runtime-$version-linux-any.tar.zst" \
  "$out/SHA256SUMS"

printf '\npublished https://github.com/%s/releases/tag/%s\n' "$repository" "$tag"
printf "Omarchy's sync-upstream picks the release up and rebuilds the ghost package; nothing to push.\n"
printf 'next: "After publishing" in packaging/release/README.md\n'
