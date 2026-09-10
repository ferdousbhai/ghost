#!/usr/bin/env bash
set -euo pipefail

usage='smoke-rendered-package.sh <version> <source-sha256> <runtime-sha256>'
[[ "$#" -eq 3 ]] || {
  printf 'usage: %s\n' "$usage" >&2
  exit 1
}
version="${1:?usage: $usage}"
source_sha="${2:?usage: $usage}"
runtime_sha="${3:?usage: $usage}"
script_root="$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${GHOST_RELEASE_REPOSITORY:-ferdousbhai/ghost}"

work_parent="${GHOST_RELEASE_WORK_ROOT:-$script_root/work}"
mkdir -p "$work_parent"
work="$(mktemp -d "$work_parent/render-smoke.XXXXXX")"
cleanup() {
  find "$work" -depth -delete
}
trap cleanup EXIT

for mask in 022 077; do
  mkdir -m755 "$work/$mask"
  rendered="$work/$mask/ghost-$version"
  (
    umask "$mask"
    bash "$script_root/render-arch-package.sh" \
      "$rendered" "$version" "$source_sha" "$runtime_sha"
  )
done

diff -ru "$work/022/ghost-$version" "$work/077/ghost-$version"
for path in \
  "$work/077/ghost-$version/PKGBUILD" \
  "$work/077/ghost-$version/.SRCINFO" \
  "$work/077/ghost-$version/ghost.install"; do
  [[ "$(stat -c '%a' "$path")" == 644 ]]
done
[[ "$(stat -c '%a' "$work/077/ghost-$version")" == 755 ]]

guard="$work/nonempty"
mkdir -p "$guard"
printf 'preserve\n' > "$guard/sentinel"
if bash "$script_root/render-arch-package.sh" \
  "$guard" "$version" "$source_sha" "$runtime_sha"; then
  printf 'renderer accepted a nonempty output directory\n' >&2
  exit 1
fi
grep -Fxq preserve "$guard/sentinel"

for invalid_version in \
  0.0.0 \
  01.2.3 \
  1.02.3 \
  1.2.03 \
  65536.1.1 \
  1.65536.1 \
  1.1.65536 \
  1.2.3-beta \
  1.2.3.4; do
  if bash "$script_root/render-arch-package.sh" \
      "$work/invalid" "$invalid_version" "$source_sha" "$runtime_sha" \
      >/dev/null 2>&1; then
    printf 'renderer accepted invalid version: %s\n' "$invalid_version" >&2
    exit 1
  fi
done

printf 'Rendered package umask smoke test passed\n'
