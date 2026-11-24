#!/usr/bin/env bash
set -euo pipefail

source_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-payload.XXXXXX")"
cleanup() { find -P "$work" -depth -delete; }
trap cleanup EXIT

runtime="$work/runtime"
mkdir -p "$runtime/bin" "$runtime/lib" "$runtime/licenses/ghost" \
  "$runtime/licenses/npm/yaml/2.9.0"
cp "$source_root/packages/daemon/scripts/launchers/launcher" "$runtime/bin/ghost"
cp "$source_root/packages/daemon/scripts/launchers/launcher" "$runtime/bin/ghostd"
printf 'console.log("0.3.0");\n' > "$runtime/lib/ghostd.js"
cp "$runtime/lib/ghostd.js" "$runtime/lib/ghost.js"
cp "$source_root/LICENSE" "$runtime/licenses/ghost/LICENSE"
cp "$source_root/THIRD_PARTY_NOTICES.md" "$runtime/licenses/ghost/THIRD_PARTY_NOTICES.md"
cp "$source_root/LICENSE" "$runtime/licenses/npm/yaml/2.9.0/LICENSE"
printf 'fixture\n' > "$runtime/BUNDLED-LICENSES"

# A stand-in for the built window: the payload check only asks its version.
printf '#!/bin/sh\necho 0.3.0\n' > "$work/ghost-window"
chmod 755 "$work/ghost-window"

# install-payload.sh ends with smoke.sh on the tree it staged.
fakeroot bash "$source_root/packaging/release/install-payload.sh" \
  "$source_root" "$runtime" "$work/payload" ghost "$work/ghost-window"
for doc in "$source_root"/docs/*.md; do
  cmp "$doc" "$work/payload/usr/share/doc/ghost/docs/${doc##*/}"
done

# Evaluate each recipe's dependencies and assembly command; nothing is built
# or installed, and no daemon runs.
verify_recipe() (
  local recipe="$1" replaced="$2"
  source "$recipe"
  srcdir="$work/recipe-source-$pkgname"
  mkdir -p "$srcdir"
  # The checkout recipe builds in ghost/, the stable one in ghost-<version>/.
  ln -s "$source_root" "$srcdir/ghost"
  ln -s "$source_root" "$srcdir/ghost-$pkgver"
  pkgdir="$work/recipe"
  bash() { printf '%s\n' "$*" > "$work/assembly"; }
  package
  [[ " ${depends[*]} " == *' bun>='* && " ${depends[*]} " == *' gtk4>='* ]]
  [[ " ${depends[*]} " != *quickshell* ]]
  # A machine holding the earlier split takes this one package in its place.
  [[ " ${replaces[*]} " == *" $replaced "* && " ${conflicts[*]} " == *" $replaced "* ]]
  [[ "$(cat "$work/assembly")" == *'packages/window/target/release/ghost-window' ]]
)
verify_recipe "$source_root/packaging/arch/PKGBUILD" ghost-runtime-dev
bash "$source_root/packaging/release/render-arch-package.sh" "$work/recipe-stable" 0.3.0 \
  "$(printf '%064d' 0)"
verify_recipe "$work/recipe-stable/PKGBUILD" ghost-runtime

printf 'Package payload regression passed\n'
