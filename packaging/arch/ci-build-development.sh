#!/usr/bin/env bash
# Build the ghost-dev package in CI from the checked-out commit. makepkg's
# check() runs the whole test suite, so this is the one job CI needs.
set -euo pipefail
(( EUID != 0 )) || {
  printf 'development package build must run as the package builder\n' >&2
  exit 1
}
workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
commit="${GITHUB_SHA:?GITHUB_SHA is required}"
git config --global --add safe.directory "$workspace"
cd -- "$workspace/packaging/arch"
GHOST_SOURCE_REPO="file://$workspace" \
  GHOST_SOURCE_REF="commit=$commit" \
  makepkg --cleanbuild --noconfirm
