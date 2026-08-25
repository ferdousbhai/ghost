#!/usr/bin/env bash
set -euo pipefail

version="${1:?usage: smoke-rendered-package.sh <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
commit="${2:?usage: smoke-rendered-package.sh <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
epoch="${3:?usage: smoke-rendered-package.sh <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
source_sha="${4:?usage: smoke-rendered-package.sh <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
runtime_sha="${5:?usage: smoke-rendered-package.sh <version> <commit> <epoch> <source-sha256> <runtime-sha256>}"
script_root="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

work_parent="${GHOST_RELEASE_WORK_ROOT:-$script_root/work}"
mkdir -p "$work_parent"
work="$(mktemp -d "$work_parent/render-smoke.XXXXXX")"
cleanup() {
  find "$work" -depth -delete
}
trap cleanup EXIT

for mask in 022 077; do
  mkdir -m755 "$work/$mask"
  rendered="$work/$mask/ghost-ai-$version-aur"
  (
    umask "$mask"
    bash "$script_root/render-arch-package.sh" \
      "$rendered" "$version" "$commit" "$epoch" "$source_sha" "$runtime_sha"
    bash "$script_root/pack-aur-source.sh" \
      "$rendered" "$work/$mask.tar.zst" "$epoch"
  )
done

cmp "$work/022.tar.zst" "$work/077.tar.zst"
for path in \
  "$work/077/ghost-ai-$version-aur/PKGBUILD" \
  "$work/077/ghost-ai-$version-aur/.SRCINFO" \
  "$work/077/ghost-ai-$version-aur/ghost-ai.install"; do
  [[ "$(stat -c '%a' "$path")" == 644 ]]
done
[[ "$(stat -c '%a' "$work/077/ghost-ai-$version-aur")" == 755 ]]

guard="$work/nonempty"
mkdir -p "$guard"
printf 'preserve\n' > "$guard/sentinel"
if bash "$script_root/render-arch-package.sh" \
  "$guard" "$version" "$commit" "$epoch" "$source_sha" "$runtime_sha"; then
  printf 'renderer accepted a nonempty output directory\n' >&2
  exit 1
fi
grep -Fxq preserve "$guard/sentinel"

printf 'Rendered package umask smoke test passed\n'
