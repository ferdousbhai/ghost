#!/usr/bin/env bash
set -euo pipefail

archive="${1:?usage: smoke-runtime-source.sh <archive> <source-root> <version> <arch> <commit> <epoch>}"
source_root="${2:?usage: smoke-runtime-source.sh <archive> <source-root> <version> <arch> <commit> <epoch>}"
version="${3:?usage: smoke-runtime-source.sh <archive> <source-root> <version> <arch> <commit> <epoch>}"
arch="${4:?usage: smoke-runtime-source.sh <archive> <source-root> <version> <arch> <commit> <epoch>}"
commit="${5:?usage: smoke-runtime-source.sh <archive> <source-root> <version> <arch> <commit> <epoch>}"
epoch="${6:?usage: smoke-runtime-source.sh <archive> <source-root> <version> <arch> <commit> <epoch>}"

archive="$(realpath "$archive")"
source_root="$(realpath "$source_root")"
work_parent="${GHOST_RELEASE_WORK_ROOT:-$(dirname "$archive")/work}"
mkdir -p "$work_parent"
work="$(mktemp -d "$work_parent/smoke.XXXXXX")"
cleanup() {
  find "$work" -depth -delete
}
trap cleanup EXIT

# GNU tar's numeric listing exposes the normalized archive owner. Symlink mode
# bits are not meaningful; regular files and directories must not be writable
# by group or world.
tar --numeric-owner -tvf "$archive" > "$work/archive.list"
awk '
  $2 != "0/0" { print "non-root archive owner: " $0 > "/dev/stderr"; bad=1 }
  substr($1,1,1) != "l" && (substr($1,6,1) == "w" || substr($1,9,1) == "w") {
    print "unsafe archive mode: " $0 > "/dev/stderr"; bad=1
  }
  END { exit bad }
' "$work/archive.list"

tar -xf "$archive" -C "$work"
runtime_root="$work/ghost-runtime-${version}-linux-${arch}"
bash "$source_root/packaging/release/verify-runtime-source.sh" \
  "$runtime_root" "$source_root" "$version" "$arch" "$commit" "$epoch"

repacked="$work/repacked.tar.zst"
bash "$source_root/packaging/release/pack-runtime-source.sh" "$runtime_root" "$repacked"
if [[ "$(sha256sum "$archive" | cut -d' ' -f1)" \
  != "$(sha256sum "$repacked" | cut -d' ' -f1)" ]]; then
  printf 'runtime source archive is not deterministically reproducible\n' >&2
  exit 1
fi

printf 'Runtime source smoke test passed: %s\n' "$archive"
