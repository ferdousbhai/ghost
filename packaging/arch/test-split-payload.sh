#!/usr/bin/env bash
set -euo pipefail

source_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-split-payload.XXXXXX")"
cleanup() { find -P "$work" -depth -delete; }
trap cleanup EXIT

runtime="$work/runtime"
mkdir -p "$runtime/bin" "$runtime/lib" "$runtime/licenses/ghost" \
  "$runtime/licenses/npm/@earendil-works/pi-ai/0.84.3"
cp "$source_root/packages/daemon/scripts/launchers/ghost" "$runtime/bin/ghost"
cp "$source_root/packages/daemon/scripts/launchers/ghostd" "$runtime/bin/ghostd"
printf 'console.log("0.3.0");\n' > "$runtime/lib/ghostd.js"
cp "$runtime/lib/ghostd.js" "$runtime/lib/ghost.js"
printf '\0asm\1\0\0\0' > "$runtime/lib/photon_rs_bg.wasm"
cp "$source_root/LICENSE" "$runtime/licenses/ghost/LICENSE"
cp "$source_root/THIRD_PARTY_NOTICES.md" "$runtime/licenses/ghost/THIRD_PARTY_NOTICES.md"
cp "$source_root/packages/daemon/scripts/runtime-licenses/earendil-pi.LICENSE" \
  "$runtime/licenses/npm/@earendil-works/pi-ai/0.84.3/LICENSE"
printf 'fixture\n' > "$runtime/BUNDLED-LICENSES"

for component in runtime ui; do
  name=ghost-runtime
  [[ "$component" == ui ]] && name=ghost
  fakeroot bash "$source_root/packaging/release/install-payload.sh" \
    "$source_root" "$runtime" "$work/$component" "$name" "$component"
  find "$work/$component" \( -type f -o -type l \) -printf '%P\n' \
    | LC_ALL=C sort > "$work/$component.files"
done
LC_ALL=C comm -12 "$work/runtime.files" "$work/ui.files" > "$work/shared.files"
[[ ! -s "$work/shared.files" ]] || {
  printf 'runtime and UI packages own the same files\n' >&2
  cat "$work/shared.files" >&2
  exit 1
}

# UI contamination must be rejected, not silently accepted by the runtime check.
mkdir -p "$work/runtime/usr/share/ghost/plugin"
if bash "$source_root/packaging/arch/smoke.sh" "$work/runtime" runtime >/dev/null 2>&1; then
  printf 'runtime smoke accepted UI files\n' >&2
  exit 1
fi

# Evaluate each package's effective dependency array and assembly selection.
# Replace only the assembly command; no build/install or daemon is run here.
verify_recipe() (
  local recipe="$1" suffix="$2"
  source "$recipe"
  srcdir="$work/recipe-source$suffix"
  mkdir -p "$srcdir"
  ln -s "$source_root" "$srcdir/ghost"
  mkdir -p "$work/recipe"
  pkgdir="$work/recipe"
  bash() { printf '%s\n' "$*" > "$work/assembly"; }
  pkgname="ghost-runtime$suffix"
  "package_$pkgname"
  [[ " ${depends[*]} " != *quickshell* && " ${depends[*]} " != *qt6-5compat* ]]
  [[ " ${depends[*]} " == *' bun>='* && " ${depends[*]} " == *' hyprland>='* ]]
  [[ "$(cat "$work/assembly")" == *' runtime' ]]
  pkgname="ghost$suffix"
  "package_$pkgname"
  [[ " ${depends[*]} " == *" ghost-runtime$suffix=$pkgver-$pkgrel "* ]]
  [[ " ${depends[*]} " == *quickshell* ]]
  [[ "$(cat "$work/assembly")" == *' ui' ]]
)
verify_recipe "$source_root/packaging/arch/PKGBUILD" -dev
bash "$source_root/packaging/release/render-arch-package.sh" "$work/recipe-stable" 0.3.0 \
  "$(printf '%064d' 0)" "$(printf '%064d' 0)"
verify_recipe "$work/recipe-stable/PKGBUILD" ''

for hook in "$source_root/packaging/arch/ghost-dev.install" \
  "$source_root/packaging/omarchy/pkgbuilds/ghost/ghost.install"; do
  output="$(bash -c 'source "$1"; pre_remove' split-hook "$hook")"
  [[ "$output" == *'omarchy plugin remove'* && "$output" != *'systemctl'* ]]
done
printf 'Split runtime/UI packaging regression passed\n'

# Exercise the removal action with command doubles: it must mark the backend
# explicit before invoking the recursive package remover, and never stop it.
mkdir -p "$work/bin" "$work/home"
cat > "$work/bin/mock" <<'SH'
#!/bin/bash
name="${0##*/}"
printf '%s %s\n' "$name" "$*" >> "$GHOST_SPLIT_TEST_LOG"
[[ "$name" != systemctl ]]
SH
chmod 755 "$work/bin/mock"
for command in omarchy sudo pacman omarchy-pkg-drop systemctl; do
  ln -s mock "$work/bin/$command"
done
GHOST_SPLIT_TEST_LOG="$work/removal.log" HOME="$work/home" PATH="$work/bin:$PATH" \
  bash "$source_root/packaging/omarchy/bin/omarchy-remove-ai-ghost" >/dev/null
cat > "$work/removal.expected" <<'EXPECTED'
omarchy plugin remove ferdousbhai.ghost --yes
pacman -Qq ghost-runtime
sudo pacman -D --asexplicit ghost-runtime
omarchy-pkg-drop ghost
EXPECTED
cmp "$work/removal.expected" "$work/removal.log"
printf 'UI removal preserves runtime regression passed\n'
