#!/usr/bin/env bash
set -euo pipefail

source_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-payload.XXXXXX")"
cleanup() { find -P "$work" -depth -delete; }
trap cleanup EXIT

# Stand-ins for the built binaries: the payload check only asks their version.
binaries="$work/release"
mkdir -p "$binaries"
for name in ghostd ghost ghost-bar; do
  printf '#!/bin/sh\necho 0.3.0\n' > "$binaries/$name"
  chmod 755 "$binaries/$name"
done

# install-payload.sh ends with smoke.sh on the tree it staged.
fakeroot bash "$source_root/packaging/release/install-payload.sh" \
  "$source_root" "$binaries" "$work/payload" ghost
for doc in "$source_root"/docs/*.md; do
  cmp "$doc" "$work/payload/usr/share/doc/ghost/docs/${doc##*/}"
done

# Evaluate the recipe's dependencies and assembly command; nothing is built
# or installed, and no daemon runs.
verify_recipe() (
  local recipe="$1" replaced="$2"
  source "$recipe"
  srcdir="$work/recipe-source-$pkgname"
  mkdir -p "$srcdir"
  ln -s "$source_root" "$srcdir/ghost-$pkgver"
  pkgdir="$work/recipe"
  bash() { printf '%s\n' "$*" > "$work/assembly"; }
  package
  # No runtime to install: the binaries need only their libraries.
  [[ " ${depends[*]} ${makedepends[*]} " != *' bun'* && " ${depends[*]} " == *' gtk4>='* ]]
  # A machine holding the earlier split takes this one package in its place.
  [[ " ${replaces[*]} " == *" $replaced "* && " ${conflicts[*]} " == *" $replaced "* ]]
  [[ "$(cat "$work/assembly")" == *" . target/release $pkgdir $pkgname" ]]
)
bash "$source_root/packaging/release/render-arch-package.sh" "$work/recipe-stable" 0.3.0 \
  "$(printf '%064d' 0)"
verify_recipe "$work/recipe-stable/PKGBUILD" ghost-runtime

printf 'Package payload regression passed\n'
