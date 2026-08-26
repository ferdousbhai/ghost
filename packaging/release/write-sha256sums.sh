#!/usr/bin/env bash
set -euo pipefail

release_dir="${1:?usage: write-sha256sums.sh <release-directory>}"
release_dir="$(realpath -e -- "$release_dir")"
[[ -d "$release_dir" ]] || {
  printf 'release checksum target is not a directory: %s\n' \
    "$release_dir" >&2
  exit 1
}
cd -- "$release_dir"

temporary="$(mktemp .SHA256SUMS.XXXXXX)"
cleanup() {
  [[ ! -e "$temporary" && ! -L "$temporary" ]] || rm -f -- "$temporary"
}
trap cleanup EXIT

LC_ALL=C find . -maxdepth 1 -type f \
  ! -name SHA256SUMS ! -name '.SHA256SUMS.*' -printf '%P\0' \
  | LC_ALL=C sort -z \
  | xargs -0 -r sha256sum -- > "$temporary"
[[ -s "$temporary" ]] || {
  printf 'release checksum target contains no artifacts: %s\n' \
    "$release_dir" >&2
  exit 1
}
chmod 644 "$temporary"
mv -Tf -- "$temporary" SHA256SUMS
trap - EXIT
