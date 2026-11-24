#!/usr/bin/env bash
set -euo pipefail

# The release version lives in the root package.json alone; the daemon and the
# window both read it there.
usage='verify-release-version.sh <source-root> | --valid <version>'

# x.y.z with no leading zeros, and not 0.0.0.
valid() {
  [[ "$1" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ && "$1" != 0.0.0 ]] && return
  printf 'not a release version: "%s"\n' "$1" >&2
  return 1
}

if [[ "${1:-}" == --valid ]]; then
  valid "${2:?usage: $usage}"
  exit
fi
source_root="$(realpath -e -- "${1:?usage: $usage}")"
version="$(bun -e 'process.stdout.write(String((await Bun.file(process.argv[1]).json()).version))' "$source_root/package.json")"
valid "$version"
printf '%s\n' "$version"
