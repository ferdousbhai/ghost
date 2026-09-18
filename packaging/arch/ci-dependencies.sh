#!/usr/bin/env bash

# Print the packages required by the Arch CI job. Build, check, and runtime
# dependencies come from the checked development .SRCINFO so this parser is
# safe to run as root before the unprivileged package builder exists.

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
mode=names
srcinfo="$script_dir/.SRCINFO"

while (( $# > 0 )); do
  case "$1" in
    --names|--constraints)
      mode="${1#--}"
      ;;
    --srcinfo)
      shift
      [[ $# -gt 0 ]] || {
        printf '%s\n' '--srcinfo requires a path' >&2
        exit 2
      }
      srcinfo="$1"
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

[[ -f "$srcinfo" && ! -L "$srcinfo" ]] || {
  printf 'dependency metadata is not a regular file: %s\n' "$srcinfo" >&2
  exit 1
}

constraints="$({
  awk -F ' = ' '
    BEGIN { count = 0; failed = 0 }
    NR == FNR {
      if ($1 == "pkgname") built[$2] = 1
      next
    }
    /^\t(depends|makedepends|checkdepends)(_x86_64)? = / {
      if (NF != 2 || $2 !~ /^[a-z0-9@_+][a-z0-9@._+-]*((=|>=|<=|>|<)[A-Za-z0-9_.+~:-]+)?$/) {
        printf "invalid dependency entry: %s\n", $0 > "/dev/stderr"
        failed = 1
        next
      }
      name = $2
      sub(/[<>=].*$/, "", name)
      if (name in built) next
      print $2
      count += 1
      next
    }
    /^\t(depends|makedepends|checkdepends)(_x86_64)?[[:space:]]/ {
      printf "malformed dependency field: %s\n", $0 > "/dev/stderr"
      failed = 1
    }
    END {
      if (count == 0) {
        print "dependency metadata contains no applicable entries" > "/dev/stderr"
        failed = 1
      }
      exit failed
    }
  ' "$srcinfo" "$srcinfo"
} | LC_ALL=C sort -u)"

if [[ "$mode" == constraints ]]; then
  printf '%s\n' "$constraints"
else
  while IFS= read -r constraint; do
    package="${constraint%%[<>=]*}"
    printf '%s\n' "$package"
  done <<< "$constraints" | LC_ALL=C sort -u
fi
