#!/usr/bin/env bash
set -euo pipefail

usage='install-payload.sh <source-root> <runtime-root> <pkgdir> <pkgname> <window-binary>'
source_root="${1:?usage: $usage}"
runtime_root="${2:?usage: $usage}"
pkgdir="${3:?usage: $usage}"
pkgname="${4:?usage: $usage}"
# The built window (packages/window).
window="$(realpath -e -- "${5:?usage: $usage}")"

source_root="$(realpath "$source_root")"
runtime_root="$(realpath "$runtime_root")"

install -Dm755 "$runtime_root/bin/ghostd" "$pkgdir/usr/bin/ghostd"
install -Dm755 "$runtime_root/bin/ghost" "$pkgdir/usr/bin/ghost"
install -Dm644 "$runtime_root/lib/ghostd.js" \
  "$pkgdir/usr/lib/ghost/runtime/ghostd.js"
install -Dm644 "$runtime_root/lib/ghost.js" \
  "$pkgdir/usr/lib/ghost/runtime/ghost.js"

install -Dm644 "$source_root/packages/daemon/contrib/ghostd.service" \
  "$pkgdir/usr/lib/systemd/user/ghostd.service"
install -Dm644 "$source_root/packaging/arch/README.md" \
  "$pkgdir/usr/share/doc/ghost/ARCH.md"
install -Dm644 "$source_root/README.md" "$pkgdir/usr/share/doc/ghost/README.md"
install -Dm644 "$source_root/CONTRACTS.md" "$pkgdir/usr/share/doc/ghost/CONTRACTS.md"
# The installed README and CONTRACTS.md link into docs/. Ship those
# link targets so the relative references resolve inside the package.
for doc in "$source_root"/docs/*.md; do
  install -Dm644 "$doc" "$pkgdir/usr/share/doc/ghost/docs/${doc##*/}"
done

# The window is the app the launcher entry opens, named by its app id so
# the compositor finds the entry's icon for it.
install -Dm755 "$window" "$pkgdir/usr/bin/ghost-window"
install -Dm644 "$source_root/packages/window/contrib/io.github.ferdousbhai.Ghost.desktop" \
  "$pkgdir/usr/share/applications/io.github.ferdousbhai.Ghost.desktop"
install -Dm644 "$source_root/packages/window/contrib/icons/ghost.svg" \
  "$pkgdir/usr/share/icons/hicolor/scalable/apps/ghost.svg"
for size in 48 128 256; do
  install -Dm644 "$source_root/packages/window/contrib/icons/ghost-$size.png" \
    "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/ghost.png"
done

install -Dm644 "$source_root/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
install -Dm644 "$source_root/THIRD_PARTY_NOTICES.md" \
  "$pkgdir/usr/share/licenses/$pkgname/THIRD_PARTY_NOTICES.md"
chown -hR 0:0 "$pkgdir"
find "$pkgdir" \( -type f -o -type d \) -exec chmod go-w {} +

bash "$source_root/packaging/arch/smoke.sh" "$pkgdir"
