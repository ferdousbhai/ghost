#!/usr/bin/env bash
set -euo pipefail

# install-payload.sh on stand-in binaries: it stages the package's tree and
# passes its own checks, and refuses a binary that names the builder's paths.
# Nothing is built or installed, and no daemon runs.
source_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-payload.XXXXXX")"
trap 'find -P "$work" -depth -delete' EXIT

# The payload's checks only ask the binaries their version.
binaries="$work/release"
mkdir -p "$binaries"
for name in ghostd ghost ghost-bar; do
  printf '#!/bin/sh\necho 0.3.0\n' > "$binaries/$name"
  chmod 755 "$binaries/$name"
done
stage() {
  HOME="$work/home" CARGO_HOME="$work/cargo" fakeroot bash "$source_root/packaging/release/install-payload.sh" \
    "$source_root" "$binaries" "$1" ghost
}

stage "$work/payload"
[[ -x "$work/payload/usr/bin/ghost-bar" && -f "$work/payload/usr/lib/systemd/user/ghostd.service" ]]

# What a build without the recipe's path remap leaves in a binary.
for leaked in "$work/cargo/registry/src/x/lib.rs" "$work/home/src/ghost/main.rs"; do
  printf '# %s\n' "$leaked" >> "$binaries/ghostd"
  if stage "$work/leaked" 2> "$work/refusal"; then
    printf 'install-payload.sh accepted a binary naming %s\n' "$leaked" >&2
    exit 1
  fi
  grep -Fq "contains the builder's path" "$work/refusal"
  sed -i '$d' "$binaries/ghostd"
  find -P "$work/leaked" -depth -delete
done

printf 'Package payload check passed\n'
