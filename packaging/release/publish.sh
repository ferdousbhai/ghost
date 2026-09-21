#!/usr/bin/env bash
# Cut a Ghost release from this machine: build the source and runtime archives,
# verify them, tag the commit, and publish a GitHub release on
# ferdousbhai/ghost (GHOST_RELEASE_REPOSITORY to override). The rendered
# Omarchy contribution lands in packaging/release/out/omarchy-ghost-<version>
# for a pull request to omacom/omarchy-pkgs.
#
#   packaging/release/publish.sh <version> [--dry-run]
#
# If the manifests do not say <version> yet, it bumps them, commits
# `release: <version>` and pushes (the pre-push hook runs the gate). After
# publishing it proves the public one-liner installs the release from a
# clean container (rolling the release back if not) and carries the rendered
# recipe to the omarchy-pkgs pull request.
#
# --dry-run builds, verifies, and renders from the committed tree and stops
# before the tag and release; it does not need HEAD to be pushed.
set -euo pipefail

usage='publish.sh <version> [--dry-run]'
version="${1:?usage: $usage}"
dry_run=0
[[ "${2:-}" != "--dry-run" ]] || dry_run=1
[[ "$#" -le 2 ]] || {
  printf 'usage: %s\n' "$usage" >&2
  exit 1
}

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
# The version lives in five manifests; a release starts by making them agree.
current="$(bash "$script_root/verify-release-version.sh" "$source_root")"
if [[ "$current" != "$version" ]]; then
  [[ "$version" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] || {
    printf 'not a release version: %s\n' "$version" >&2
    exit 1
  }
  for manifest in package.json packages/daemon/package.json packages/extensions/package.json \
      packages/shell/package.json packages/shell/qml/manifest.json; do
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
(( dry_run )) || gh auth status >/dev/null

commit="$(git rev-parse 'HEAD^{commit}')"
epoch="$(git show -s --format=%ct "$commit")"
work="$script_root/work"
rm -rf -- "$out" "$work"
mkdir -p -- "$out" "$work"

bash "$script_root/prepare-pnpm-engine.sh" "$source_root"
pnpm fetch --frozen-lockfile
SOURCE_DATE_EPOCH="$epoch" \
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
bash "$script_root/write-sha256sums.sh" "$out"

source_sha="$(sha256sum "$out/ghost-$version.tar.gz" | cut -d' ' -f1)"
runtime_sha="$(sha256sum "$out/ghost-runtime-$version-linux-any.tar.zst" | cut -d' ' -f1)"
GHOST_RELEASE_REPOSITORY="$repository" \
  bash "$script_root/smoke-rendered-package.sh" "$version" "$source_sha" "$runtime_sha"
GHOST_RELEASE_REPOSITORY="$repository" \
  bash "$script_root/../omarchy/render-contribution.sh" \
    "$out/omarchy-ghost-$version" "$version" "$source_sha" "$runtime_sha"
# The built, signed packages: the release doubles as the [ghost] pacman
# repository until Omarchy's own repository carries the package.
bash "$script_root/build-repo.sh" "$out" "$version"

printf '\nrelease inputs for %s %s (%s):\n' "$repository" "$tag" "$commit"
cat -- "$out/SHA256SUMS"
if (( dry_run )); then
  printf '\ndry run: no tag, no release. Omarchy contribution: %s; signed repository: %s\n' \
    "$out/omarchy-ghost-$version" "$out/repo"
  exit 0
fi

git tag -a "$tag" -m "ghost $version" "$commit"
git push origin "$tag"
gh release create "$tag" \
  --repo "$repository" \
  --title "ghost $version" \
  --notes "Install on Omarchy: \`curl -fsSL https://summonghost.com/install | bash\` (adds this release as the signed \`[ghost]\` pacman repository, then installs the package). Also the source and runtime inputs for the Omarchy \`ghost\` package." \
  -- \
  "$out/ghost-$version.tar.gz" \
  "$out/ghost-runtime-$version-linux-any.tar.zst" \
  "$out/ghost-runtime-$version-linux-any.tar.zst.sha256" \
  "$out/SHA256SUMS" \
  "$out/omarchy-ghost-$version/PKGBUILD" \
  "$out/omarchy-ghost-$version/"*.install \
  "$out/repo/"*

printf '\npublished https://github.com/%s/releases/tag/%s\n' "$repository" "$tag"

# Shipped means installable: the public one-liner must land this version
# in a clean container. If it does not, "latest" must not point at it.
if ! bash "$script_root/verify-published.sh" "$version"; then
  printf 'rolling back %s\n' "$tag" >&2
  gh release delete "$tag" --repo "$repository" --yes --cleanup-tag
  git tag -d "$tag" >/dev/null 2>&1 || true
  exit 1
fi

# The omarchy-pkgs pull request tracks the release by hand until the package
# is upstream; a failure here leaves the release intact and says what to do.
bash "$script_root/update-omarchy-contribution.sh" "$version" "$out/omarchy-ghost-$version" || \
  printf 'could not update the omarchy-pkgs branch; push %s to pkgbuilds/ghost on the fork by hand\n' \
    "$out/omarchy-ghost-$version" >&2
printf 'next: "After publishing" in packaging/release/README.md\n'
