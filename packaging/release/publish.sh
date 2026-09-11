#!/usr/bin/env bash
# Cut a Ghost release from this machine: build the source and runtime archives,
# verify them, tag the commit, and publish a GitHub release on
# ferdousbhai/ghost (GHOST_RELEASE_REPOSITORY to override). The rendered
# Omarchy contribution lands in packaging/release/out/omarchy-ghost-<version>
# for a pull request to omacom/omarchy-pkgs.
#
#   packaging/release/publish.sh <version> [--dry-run]
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
if (( ! dry_run )); then
  git fetch -q origin master
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/master)" ]] || {
    printf 'HEAD is not origin/master; push (or pull) first\n' >&2
    exit 1
  }
  if git rev-parse -q --verify "refs/tags/$tag" >/dev/null; then
    printf 'tag %s already exists\n' "$tag" >&2
    exit 1
  fi
fi
bash "$script_root/verify-release-version.sh" "$source_root" | grep -Fxq "$version" || {
  printf 'the manifests do not all say %s; bump the version first\n' "$version" >&2
  exit 1
}
(( dry_run )) || gh auth status >/dev/null

commit="$(git rev-parse 'HEAD^{commit}')"
epoch="$(git show -s --format=%ct "$commit")"
work="$script_root/work"
rm -rf -- "$out" "$work"
mkdir -p -- "$out" "$work"

bash "$script_root/prepare-pnpm-engine.sh" "$source_root"
pnpm fetch --frozen-lockfile
# The optional Claude Agent SDK graph is not packaged, but its pins, the loader,
# and the runtime doc must still agree at release time.
pnpm fetch --dir "$script_root/fixtures/claude-agent-sdk" --frozen-lockfile
GHOST_CLAUDE_SDK_BOUNDARY_TEST_ROOT="$script_root/work" \
  bash "$script_root/test-claude-sdk-boundary.sh"
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

printf '\nrelease inputs for %s %s (%s):\n' "$repository" "$tag" "$commit"
cat -- "$out/SHA256SUMS"
if (( dry_run )); then
  printf '\ndry run: no tag, no release. Omarchy contribution: %s\n' "$out/omarchy-ghost-$version"
  exit 0
fi

git tag -a "$tag" -m "ghost $version" "$commit"
git push origin "$tag"
gh release create "$tag" \
  --repo "$repository" \
  --title "ghost $version" \
  --notes "Source and runtime inputs for the Omarchy \`ghost\` package. Install through Omarchy: Install → AI → Ghost." \
  -- \
  "$out/ghost-$version.tar.gz" \
  "$out/ghost-runtime-$version-linux-any.tar.zst" \
  "$out/ghost-runtime-$version-linux-any.tar.zst.sha256" \
  "$out/SHA256SUMS" \
  "$out/omarchy-ghost-$version/PKGBUILD" \
  "$out/omarchy-ghost-$version/ghost.install"

printf '\npublished https://github.com/%s/releases/tag/%s\n' "$repository" "$tag"
printf 'next: copy %s to pkgbuilds/ghost in a fork of omacom/omarchy-pkgs and open the pull request\n' \
  "$out/omarchy-ghost-$version"
