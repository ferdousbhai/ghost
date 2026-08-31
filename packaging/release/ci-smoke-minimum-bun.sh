#!/usr/bin/env bash

set -euo pipefail

(( EUID != 0 )) || {
  printf 'minimum Bun artifact gate must run as the package builder\n' >&2
  exit 1
}

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ci-release-paths.sh
source "$script_dir/ci-release-paths.sh"
ghost_ci_validate_release_paths

source_tree="$workspace/packaging/arch/src/ghost"
[[ -d "$source_tree" && ! -L "$source_tree" ]] || {
  printf 'stable source tree is not a real directory\n' >&2
  exit 1
}
version="$(bash "$source_tree/packaging/release/verify-release-version.sh" \
  "$source_tree")"
commit="$(git -C "$source_tree" rev-parse 'HEAD^{commit}')"
epoch="$(git -C "$source_tree" show -s --format=%ct "$commit")"
archive="$GHOST_CI_RELEASE_OUT/ghost-runtime-$version-linux-x86_64.tar.zst"
[[ -f "$archive" && ! -L "$archive"
  && "$(realpath -e -- "$archive")" == "$archive" ]] || {
  printf 'minimum Bun gate cannot find the exact runtime archive\n' >&2
  exit 1
}

GHOST_MINIMUM_BUN_SMOKE_ROOT="$GHOST_CI_RELEASE_WORK" \
  bash "$source_tree/packaging/release/smoke-runtime-minimum-bun.sh" \
    "$archive" "$source_tree" "$version" x86_64 "$commit" "$epoch"
