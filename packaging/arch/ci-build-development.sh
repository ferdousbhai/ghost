#!/usr/bin/env bash

set -euo pipefail

(( EUID != 0 )) || {
  printf 'development package build must run as the package builder\n' >&2
  exit 1
}

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
commit="${GITHUB_SHA:?GITHUB_SHA is required}"
source_repo="$(bash "$workspace/packaging/arch/resolve-ci-source-repo.sh" \
  "$commit")"
cd -- "$workspace/packaging/arch"
GHOST_SOURCE_REPO="$source_repo" \
  GHOST_SOURCE_REF="commit=$commit" \
  makepkg --cleanbuild --noconfirm
