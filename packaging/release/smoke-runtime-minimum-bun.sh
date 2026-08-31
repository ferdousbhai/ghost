#!/usr/bin/env bash

set -euo pipefail

GHOST_MINIMUM_BUN_VERSION=1.3.14
GHOST_MINIMUM_BUN_SHA256=951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f
GHOST_MINIMUM_BUN_URL=https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip

ghost_verify_minimum_bun_archive() {
  local archive="${1:?Bun archive is required}"
  local expected_sha="${2:?expected SHA-256 is required}"
  local expected_version="${3:?expected Bun version is required}"
  local destination="${4:?extraction destination is required}"
  local actual_sha listing bun version

  [[ -f "$archive" && ! -L "$archive" ]] || {
    printf 'minimum Bun download is not a regular file: %s\n' "$archive" >&2
    return 1
  }
  [[ "$expected_sha" =~ ^[0-9a-f]{64}$
    && "$expected_version" =~ ^[0-9]+([.][0-9]+){2}$ ]] || {
    printf 'minimum Bun verifier received an invalid pinned identity\n' >&2
    return 1
  }
  actual_sha="$(sha256sum "$archive" | cut -d' ' -f1)"
  [[ "$actual_sha" == "$expected_sha" ]] || {
    printf 'minimum Bun archive SHA-256 %s does not match pinned %s\n' \
      "$actual_sha" "$expected_sha" >&2
    return 1
  }

  listing="$(bsdtar -tf "$archive")"
  [[ "$listing" == $'bun-linux-x64/\nbun-linux-x64/bun' ]] || {
    printf 'minimum Bun archive has an unexpected file closure\n' >&2
    return 1
  }
  [[ ! -e "$destination" && ! -L "$destination" ]] || {
    printf 'minimum Bun extraction destination already exists: %s\n' "$destination" >&2
    return 1
  }
  install -d -m700 "$destination"
  bsdtar --no-same-owner --no-same-permissions -xf "$archive" -C "$destination"
  bun="$destination/bun-linux-x64/bun"
  [[ -f "$bun" && ! -L "$bun" && -x "$bun"
    && "$(realpath -e -- "$bun")" == "$bun" ]] || {
    printf 'minimum Bun executable is missing or unsafe\n' >&2
    return 1
  }
  install -d -m700 "$destination/home"
  version="$(env -i HOME="$destination/home" PATH=/usr/bin \
    timeout 20 "$bun" --version)"
  [[ "$version" == "$expected_version" ]] || {
    printf 'minimum Bun executable reports %s, expected exactly %s\n' \
      "$version" "$expected_version" >&2
    return 1
  }
  printf '%s\n' "$bun"
}

ghost_smoke_runtime_minimum_bun() (
  local usage archive source_root version arch commit epoch temp_parent work bun_archive bun
  usage='smoke-runtime-minimum-bun.sh <archive> <source-root> <version> <arch> <commit> <epoch>'
  archive="${1:?usage: $usage}"
  source_root="${2:?usage: $usage}"
  version="${3:?usage: $usage}"
  arch="${4:?usage: $usage}"
  commit="${5:?usage: $usage}"
  epoch="${6:?usage: $usage}"

  archive="$(realpath -e -- "$archive")"
  source_root="$(realpath -e -- "$source_root")"
  [[ -f "$archive" && ! -L "$archive" && -d "$source_root" && ! -L "$source_root" ]] || {
    printf 'minimum Bun smoke received an unsafe archive or source root\n' >&2
    return 1
  }
  for command in bsdtar curl sha256sum timeout; do
    command -v "$command" >/dev/null || {
      printf 'minimum Bun smoke requires %s\n' "$command" >&2
      return 1
    }
  done

  temp_parent="${GHOST_MINIMUM_BUN_SMOKE_ROOT:-${TMPDIR:-/tmp}}"
  mkdir -p "$temp_parent"
  temp_parent="$(realpath -e -- "$temp_parent")"
  [[ -d "$temp_parent" && ! -L "$temp_parent" ]] || {
    printf 'minimum Bun smoke parent is not a real directory\n' >&2
    return 1
  }
  work="$(mktemp -d "$temp_parent/ghost-minimum-bun.XXXXXX")"
  chmod 700 "$work"
  cleanup() {
    find -P "$work" -depth -delete
  }
  trap cleanup EXIT

  bun_archive="$work/bun-linux-x64.zip"
  curl --proto '=https' --tlsv1.2 --fail --location --silent --show-error \
    --output "$bun_archive" "$GHOST_MINIMUM_BUN_URL"
  bun="$(ghost_verify_minimum_bun_archive \
    "$bun_archive" "$GHOST_MINIMUM_BUN_SHA256" \
    "$GHOST_MINIMUM_BUN_VERSION" "$work/extracted")"
  install -d -m700 "$work/runtime-smoke"
  GHOST_RUNTIME_SMOKE_BUN="$bun" \
    GHOST_RELEASE_WORK_ROOT="$work/runtime-smoke" \
    bash "$source_root/packaging/release/smoke-runtime-source.sh" \
      "$archive" "$source_root" "$version" "$arch" "$commit" "$epoch"
  printf 'Runtime archive passed with pinned minimum Bun %s\n' \
    "$GHOST_MINIMUM_BUN_VERSION"
)

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ghost_smoke_runtime_minimum_bun "$@"
fi
