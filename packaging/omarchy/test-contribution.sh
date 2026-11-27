#!/usr/bin/env bash
set -euo pipefail

# Omarchy's recipe as render-arch-package.sh writes it: what goes into
# pkgbuilds/ghost of omarchy-pkgs, and into a release as ghost-recipe.tar.gz.
script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
render="$script_root/../release/render-arch-package.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-omarchy-contribution.XXXXXX")"
trap 'find -P "$work" -depth -delete' EXIT

version=1.2.3
source_sha="$(printf '%064d' 0)"

# The same files, contents and modes under either umask.
for mask in 022 077; do
  (umask "$mask"; bash "$render" "$work/$mask" "$version" "$source_sha")
  [[ "$(find "$work/$mask" -printf '%P %m\n' | LC_ALL=C sort | tr '\n' ' ')" == \
    ' 755 .omarchy 755 .omarchy/package.json 644 PKGBUILD 644 ghost.install 644 ' ]]
done
diff -r "$work/022" "$work/077"

# A directory with something in it is left as it was.
if bash "$render" "$work/022" "$version" "$source_sha" 2>/dev/null; then
  printf 'the renderer wrote into a nonempty directory\n' >&2
  exit 1
fi
diff -r "$work/022" "$work/077"

(
  # shellcheck disable=SC1091,SC2154,SC2329
  source "$work/022/PKGBUILD"
  [[ "$pkgver" == "$version" && "${sha256sums[0]}" == "$source_sha" ]]
  [[ "${source[0]}" == "ghost-$version.tar.gz::https://github.com/ferdousbhai/ghost/releases/download/v$version/ghost-$version.tar.gz" ]]
  # A machine holding 0.11.9's two packages takes this one in their place;
  # without it `omarchy update` stops on a file conflict.
  [[ " ${replaces[*]} " == *' ghost-runtime '* && " ${conflicts[*]} " == *' ghost-runtime '* ]]
  # package() hands install-payload.sh what it takes, in its order.
  srcdir="$work/src" pkgdir="$work/pkg"
  mkdir -p "$srcdir/ghost-$version"
  bash() { printf '%s\n' "$*" > "$work/assembly"; }
  package
  [[ "$(cat "$work/assembly")" == "packaging/release/install-payload.sh . target/release $pkgdir ghost" ]]
)

printf 'Omarchy contribution check passed\n'
