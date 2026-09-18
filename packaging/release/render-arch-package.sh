#!/usr/bin/env bash
set -euo pipefail

script_root="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
template_root="$script_root/../omarchy/pkgbuilds/ghost"
usage='render-arch-package.sh <output-dir> <version> <source-sha256> <runtime-sha256>'
[[ "$#" -eq 4 ]] || {
  printf 'usage: %s\n' "$usage" >&2
  exit 1
}
output="${1:?usage: $usage}"
version="${2:?usage: $usage}"
source_sha="${3:?usage: $usage}"
runtime_sha="${4:?usage: $usage}"
release_repository="${GHOST_RELEASE_REPOSITORY:-ferdousbhai/ghost}"

if [[ "$version" =~ ^(0|[1-9][0-9]{0,4})[.](0|[1-9][0-9]{0,4})[.](0|[1-9][0-9]{0,4})$ ]]; then
  major="${BASH_REMATCH[1]}"
  minor="${BASH_REMATCH[2]}"
  patch="${BASH_REMATCH[3]}"
else
  printf 'invalid release version: %s\n' "$version" >&2
  exit 1
fi
if (( 10#$major > 65535 || 10#$minor > 65535 || 10#$patch > 65535 ||
      (10#$major == 0 && 10#$minor == 0 && 10#$patch == 0) )); then
  printf 'invalid release version: %s\n' "$version" >&2
  exit 1
fi
[[ "$source_sha" =~ ^[0-9a-f]{64}$ ]]
[[ "$runtime_sha" =~ ^[0-9a-f]{64}$ ]]
[[ "$release_repository" =~ ^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || {
  printf 'invalid GHOST_RELEASE_REPOSITORY: %s\n' "$release_repository" >&2
  exit 1
}

output_parent="$(realpath "$(dirname "$output")")"
output="$output_parent/$(basename "$output")"
[[ "$output" != / && "$output" != "$output_parent" && ! -L "$output" ]]
if [[ -e "$output" ]]; then
  [[ -d "$output" ]]
  if find "$output" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    printf 'refusing to render into nonempty directory: %s\n' "$output" >&2
    exit 1
  fi
else
  mkdir -m755 "$output"
fi
chmod 755 "$output"
sed \
  -e "s/@@VERSION@@/$version/g" \
  -e "s/@@SOURCE_SHA256@@/$source_sha/g" \
  -e "s/@@RUNTIME_SHA256@@/$runtime_sha/g" \
  -e "s|@@RELEASE_REPOSITORY@@|$release_repository|g" \
  "$template_root/PKGBUILD.in" > "$output/PKGBUILD"
chmod 644 "$output/PKGBUILD"
install -m644 "$template_root/"*.install "$output/"

if grep -En '@@[A-Z0-9_]+@@' "$output/PKGBUILD"; then
  printf 'unrendered PKGBUILD token remains\n' >&2
  exit 1
fi
(
  cd "$output"
  makepkg --printsrcinfo > .SRCINFO
  chmod 644 .SRCINFO
)
