#!/usr/bin/env bash

set -euo pipefail

(( EUID != 0 )) || {
  printf 'package ownership verification must run as the package builder\n' >&2
  exit 1
}

(( $# > 0 )) || {
  printf 'usage: verify-package-archive-ownership.sh <archive> [...]\n' >&2
  exit 2
}

temp_base="${GHOST_RELEASE_VERIFY_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p -- "$temp_base"
work="$(mktemp -d "$temp_base/ghost-package-owner-verify.XXXXXXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

index=0
for input in "$@"; do
  [[ -f "$input" && ! -L "$input" ]] || {
    printf 'package archive is not a regular file: %s\n' "$input" >&2
    exit 1
  }
  archive="$(realpath -e -- "$input")"
  listing="$work/$index.list"
  index=$((index + 1))

  if ! LC_ALL=C bsdtar --numeric-owner --list --verbose \
    --file "$archive" > "$listing"; then
    printf 'could not inspect package archive metadata: %s\n' "$archive" >&2
    exit 1
  fi

  LC_ALL=C awk -v archive="$archive" '
      {
        entries += 1
        if (NF < 4 || $3 !~ /^[0-9]+$/ || $4 !~ /^[0-9]+$/) {
          if (!bad) {
            printf "%s: malformed ownership metadata at archive entry %d\n", \
              archive, entries > "/dev/stderr"
          }
          bad = 1
        } else if ($3 != "0" || $4 != "0") {
          if (!bad) {
            printf "%s: package archive entry %d has non-root ownership (%s:%s)\n", \
              archive, entries, $3, $4 > "/dev/stderr"
          }
          bad = 1
        }
      }
      END {
        if (entries == 0) {
          printf "%s: package archive contains no entries\n", archive \
            > "/dev/stderr"
          bad = 1
        }
        exit bad
      }
    ' "$listing"
done
