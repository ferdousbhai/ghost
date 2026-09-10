#!/usr/bin/env bash

set -euo pipefail

script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
release_root="$script_root/../release"
template_root="$script_root/pkgbuilds/ghost"
usage='render-contribution.sh <output-dir> <version> <source-sha256> <runtime-sha256>'
[[ "$#" -eq 4 ]] || {
  printf 'usage: %s\n' "$usage" >&2
  exit 1
}
output="${1:?usage: $usage}"
release_repository="${GHOST_RELEASE_REPOSITORY:-ferdousbhai/ghost}"

bash "$release_root/render-arch-package.sh" "$@"
rm -- "$output/.SRCINFO"
install -d -m755 -- "$output/.omarchy"
sed "s|@@RELEASE_REPOSITORY@@|$release_repository|g" \
  "$template_root/.omarchy/package.json.in" > "$output/.omarchy/package.json"
chmod 644 -- "$output/.omarchy/package.json"

if grep -REn '@@[A-Z0-9_]+@@' "$output"; then
  printf 'unrendered Omarchy contribution token remains\n' >&2
  exit 1
fi
