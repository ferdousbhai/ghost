#!/usr/bin/env bash
set -euo pipefail

# Omarchy's recipe for one release (pkgbuilds/ghost in omacom/omarchy-pkgs),
# from the template in packaging/omarchy: PKGBUILD, ghost.install, and
# .omarchy/package.json, the release feed Omarchy's sync-upstream reads. The
# same files and modes whatever the caller's umask.
script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
template_root="$script_root/../omarchy/pkgbuilds/ghost"
usage='render-arch-package.sh <output-dir> <version> <source-sha256>'
[[ "$#" -eq 3 ]] || {
  printf 'usage: %s\n' "$usage" >&2
  exit 1
}
output="$1"
version="$2"
source_sha="$3"

bash "$script_root/verify-release-version.sh" --valid "$version"
[[ "$source_sha" =~ ^[0-9a-f]{64}$ ]] || {
  printf 'not a SHA-256: %s\n' "$source_sha" >&2
  exit 1
}

# Into a new or empty directory only: nothing of the caller's is written over.
if [[ -e "$output" || -L "$output" ]]; then
  if [[ ! -d "$output" || -L "$output" ]] || find "$output" -mindepth 1 -print -quit | grep -q .; then
    printf 'refusing to render into %s: not an empty directory\n' "$output" >&2
    exit 1
  fi
fi
install -d -m755 -- "$output" "$output/.omarchy"
sed -e "s/@@VERSION@@/$version/g" -e "s/@@SOURCE_SHA256@@/$source_sha/g" \
  "$template_root/PKGBUILD.in" > "$output/PKGBUILD"
chmod 644 -- "$output/PKGBUILD"
install -m644 -- "$template_root/ghost.install" "$output/ghost.install"
install -m644 -- "$template_root/.omarchy/package.json" "$output/.omarchy/package.json"

if grep -En '@@[A-Z0-9_]+@@' "$output/PKGBUILD"; then
  printf 'unrendered PKGBUILD token remains\n' >&2
  exit 1
fi
