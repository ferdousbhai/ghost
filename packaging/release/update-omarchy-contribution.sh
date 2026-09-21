#!/usr/bin/env bash
# Carry a release's rendered recipe to the omarchy-pkgs pull request: replace
# pkgbuilds/ghost on the fork's `ghost` branch with the render and push, so
# the open PR (omacom/omarchy-pkgs#390) tracks the release. Once the package
# is merged upstream, sync-upstream does this for every tag and this script
# retires. publish.sh runs it after a verified release.
#
#   update-omarchy-contribution.sh <version> <rendered-dir>
#
# GHOST_PKGS_FORK (default ferdousbhai/omarchy-pkgs) and GHOST_PKGS_BRANCH
# (default ghost) name the fork and branch.
set -euo pipefail

usage='update-omarchy-contribution.sh <version> <rendered-dir>'
version="${1:?usage: $usage}"
rendered="$(realpath -e -- "${2:?usage: $usage}")"
fork="${GHOST_PKGS_FORK:-ferdousbhai/omarchy-pkgs}"
branch="${GHOST_PKGS_BRANCH:-ghost}"
script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

work_parent="${GHOST_RELEASE_WORK_ROOT:-$script_root/work}"
mkdir -p -- "$work_parent"
clone="$(mktemp -d "$work_parent/omarchy-pkgs.XXXXXX")"
cleanup() {
  find "$clone" -depth -delete
}
trap cleanup EXIT

git clone -q --depth 1 --branch "$branch" "https://github.com/$fork.git" "$clone"
rm -rf -- "$clone/pkgbuilds/ghost"
cp -a -- "$rendered" "$clone/pkgbuilds/ghost"
cd -- "$clone"
git add -A pkgbuilds/ghost
if git diff --cached --quiet; then
  printf 'omarchy-pkgs %s already carries ghost %s\n' "$branch" "$version"
  exit 0
fi
git -c user.name="$(git -C "$script_root" config user.name)" \
    -c user.email="$(git -C "$script_root" config user.email)" \
    commit -q -m "ghost: $version"
git push -q origin "$branch"
printf 'omarchy-pkgs %s now carries ghost %s\n' "$branch" "$version"
