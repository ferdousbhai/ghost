#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: frozen-inputs.sh <source-root>}"
source_root="$(realpath "$source_root")"

(
  cd "$source_root"
  {
    printf '%s\0' \
      package.json \
      pnpm-lock.yaml \
      pnpm-workspace.yaml \
      packages/daemon/scripts/build-binary.sh
    [[ ! -f .npmrc ]] || printf '%s\0' .npmrc
    find packages -mindepth 2 -maxdepth 2 -type f -name package.json -print0
  } | LC_ALL=C sort -zu | xargs -0 sha256sum
)
