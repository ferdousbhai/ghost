#!/usr/bin/env bash
set -euo pipefail

# The release version lives in the root Cargo.toml alone ([workspace.package]);
# the daemon and the bar both inherit it.
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
version="$(awk '
  /^\[/ { in_package = ($0 == "[workspace.package]") }
  in_package && /^version[[:space:]]*=/ { gsub(/^[^"]*"|"[^"]*$/, ""); print; exit }
' "$source_root/Cargo.toml")"
valid "$version"
printf '%s\n' "$version"
