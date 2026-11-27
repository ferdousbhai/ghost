#!/usr/bin/env bash
set -euo pipefail

# Stages the package's files into <pkgdir> (the recipe's package()), then
# checks what it staged.
usage='install-payload.sh <source-root> <binaries> <pkgdir> <pkgname>'
source_root="${1:?usage: $usage}"
# Where cargo left the release build: ghostd, ghost and ghost-bar.
binaries="$(realpath -e -- "${2:?usage: $usage}")"
pkgdir="${3:?usage: $usage}"
pkgname="${4:?usage: $usage}"

source_root="$(realpath "$source_root")"

install -Dm755 "$binaries/ghostd" "$pkgdir/usr/bin/ghostd"
install -Dm755 "$binaries/ghost" "$pkgdir/usr/bin/ghost"

install -Dm644 "$source_root/packages/daemon/contrib/ghostd.service" \
  "$pkgdir/usr/lib/systemd/user/ghostd.service"
install -Dm644 "$source_root/README.md" "$pkgdir/usr/share/doc/ghost/README.md"
install -Dm644 "$source_root/CONTRACTS.md" "$pkgdir/usr/share/doc/ghost/CONTRACTS.md"
# The installed README and CONTRACTS.md link into docs/. Ship those
# link targets so the relative references resolve inside the package.
for doc in "$source_root"/docs/*.md; do
  install -Dm644 "$doc" "$pkgdir/usr/share/doc/ghost/docs/${doc##*/}"
done

# The bar is what the launcher entry summons, named by its app id so
# the compositor finds the entry's icon for it.
install -Dm755 "$binaries/ghost-bar" "$pkgdir/usr/bin/ghost-bar"
install -Dm644 "$source_root/packages/bar/contrib/io.github.ferdousbhai.Ghost.desktop" \
  "$pkgdir/usr/share/applications/io.github.ferdousbhai.Ghost.desktop"
install -Dm644 "$source_root/packages/bar/contrib/icons/ghost.svg" \
  "$pkgdir/usr/share/icons/hicolor/scalable/apps/ghost.svg"
for size in 48 128 256; do
  install -Dm644 "$source_root/packages/bar/contrib/icons/ghost-$size.png" \
    "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/ghost.png"
done

install -Dm644 "$source_root/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
install -Dm644 "$source_root/THIRD_PARTY_NOTICES.md" \
  "$pkgdir/usr/share/licenses/$pkgname/THIRD_PARTY_NOTICES.md"
chown -hR 0:0 "$pkgdir"
find "$pkgdir" \( -type f -o -type d \) -exec chmod go-w {} +

refuse() {
  printf 'ghost package: %s\n' "$*" >&2
  exit 1
}

desktop-file-validate "$pkgdir/usr/share/applications/io.github.ferdousbhai.Ghost.desktop"

# Without a display or a daemon: one release version from all three, and
# printing it proves each binary loads its libraries.
version="$("$pkgdir/usr/bin/ghostd" --version)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || refuse "ghostd --version printed \"$version\""
for name in ghost ghost-bar; do
  [[ "$("$pkgdir/usr/bin/$name" --version)" == "$version" ]] || refuse "$name is not version $version"
done

# A Chromium the ghost starts in the unit's cgroup needs its sandbox's user
# namespaces.
if grep -Eq '^[[:space:]]*RestrictNamespaces=' "$pkgdir/usr/lib/systemd/user/ghostd.service"; then
  refuse 'ghostd.service blocks the namespaces the Chromium sandbox needs'
fi

# The recipe's path remap held: no binary names the builder's cargo directory
# or home in a panic message.
builder_paths=("${CARGO_HOME:-$HOME/.cargo}/")
[[ "$HOME" == / ]] || builder_paths+=("$HOME/")
for name in ghostd ghost ghost-bar; do
  for path in "${builder_paths[@]}"; do
    ! grep -aqF -- "$path" "$pkgdir/usr/bin/$name" || refuse "$name contains the builder's path $path"
  done
done
