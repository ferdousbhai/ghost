#!/usr/bin/env bash
set -euo pipefail

template_root="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
output="${1:?usage: render-arch-package.sh <output-dir> <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
version="${2:?usage: render-arch-package.sh <output-dir> <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
commit="${3:?usage: render-arch-package.sh <output-dir> <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
epoch="${4:?usage: render-arch-package.sh <output-dir> <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
source_sha="${5:?usage: render-arch-package.sh <output-dir> <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
runtime_sha="${6:?usage: render-arch-package.sh <output-dir> <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"

[[ "$version" =~ ^[0-9]+([.][0-9]+){2}([.][a-z0-9]+)*$ ]]
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
[[ "$epoch" =~ ^[0-9]+$ ]]
[[ "$source_sha" =~ ^[0-9a-f]{64}$ ]]
[[ "$runtime_sha" =~ ^[0-9a-f]{64}$ ]]

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
  -e "s/@@SOURCE_COMMIT@@/$commit/g" \
  -e "s/@@SOURCE_DATE_EPOCH@@/$epoch/g" \
  -e "s/@@SOURCE_SHA256@@/$source_sha/g" \
  -e "s/@@RUNTIME_SHA256@@/$runtime_sha/g" \
  "$template_root/PKGBUILD.in" > "$output/PKGBUILD"
chmod 644 "$output/PKGBUILD"
install -m644 "$template_root/ghost-ai.install" "$output/ghost-ai.install"

if grep -En '@@[A-Z0-9_]+@@' "$output/PKGBUILD"; then
  printf 'unrendered PKGBUILD token remains\n' >&2
  exit 1
fi
(
  cd "$output"
  makepkg --printsrcinfo > .SRCINFO
  chmod 644 .SRCINFO
)
