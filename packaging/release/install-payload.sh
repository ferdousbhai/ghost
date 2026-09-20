#!/usr/bin/env bash
set -euo pipefail

usage='install-payload.sh <source-root> <runtime-root> <pkgdir> <pkgname> <runtime|ui>'
source_root="${1:?usage: $usage}"
runtime_root="${2:?usage: $usage}"
pkgdir="${3:?usage: $usage}"
pkgname="${4:?usage: $usage}"
component="${5:?usage: $usage}"
[[ "$component" == runtime || "$component" == ui ]] || {
  printf 'unknown package component: %s\n' "$component" >&2
  exit 2
}

source_root="$(realpath "$source_root")"
runtime_root="$(realpath "$runtime_root")"

install_tree() {
  local source_dir="$1"
  local destination_dir="$2"
  local directory file relative mode

  install -d -m755 -o root -g root "$destination_dir"
  while IFS= read -r -d '' directory; do
    relative="${directory#"$source_dir"/}"
    install -d -m755 -o root -g root "$destination_dir/$relative"
  done < <(find "$source_dir" -mindepth 1 -type d -print0)
  while IFS= read -r -d '' file; do
    relative="${file#"$source_dir"/}"
    mode=644
    [[ -x "$file" ]] && mode=755
    install -Dm"$mode" -o root -g root "$file" "$destination_dir/$relative"
  done < <(find "$source_dir" -type f -print0)
}

appdir="$pkgdir/usr/lib/ghost"
sharedir="$pkgdir/usr/share/ghost"

if [[ "$component" == runtime ]]; then
  install -Dm755 "$runtime_root/bin/ghostd" "$pkgdir/usr/bin/ghostd"
  install -Dm755 "$runtime_root/bin/ghost" "$pkgdir/usr/bin/ghost"
  install -Dm644 "$runtime_root/lib/ghostd.js" \
    "$pkgdir/usr/lib/ghost/runtime/ghostd.js"
  install -Dm644 "$runtime_root/lib/ghost.js" \
    "$pkgdir/usr/lib/ghost/runtime/ghost.js"
  install -Dm644 "$runtime_root/lib/photon_rs_bg.wasm" \
    "$pkgdir/usr/lib/ghost/runtime/photon_rs_bg.wasm"
  install -Dm755 "$source_root/packaging/arch/ghost-desktop-helper" \
    "$pkgdir/usr/bin/ghost-desktop-helper"

  while IFS= read -r -d '' file; do
    install -Dm644 "$file" \
      "$appdir/desktop-helper/${file#"$source_root/packages/desktop-helper/src/"}"
  done < <(find "$source_root/packages/desktop-helper/src" -type f \
    \( -name '*.py' -o -name LICENSE \) -print0)

  install -Dm644 "$source_root/packages/daemon/contrib/ghostd.service" \
    "$pkgdir/usr/lib/systemd/user/ghostd.service"
  install -Dm755 "$source_root/packaging/arch/service-browser-smoke.sh" \
    "$pkgdir/usr/lib/ghost/package-smoke/service-browser-smoke.sh"

  install -Dm644 "$source_root/packaging/arch/README.md" \
    "$pkgdir/usr/share/doc/ghost/ARCH.md"
  install -Dm644 "$source_root/README.md" "$pkgdir/usr/share/doc/ghost/README.md"
  install -Dm644 "$source_root/CONTRACTS.md" "$pkgdir/usr/share/doc/ghost/CONTRACTS.md"
  # The installed README, CONTRACTS.md, and ARCH.md link into docs/. Ship those
  # link targets so the relative references resolve inside the package.
  for doc in hooks.md self-maintenance.md; do
    install -Dm644 "$source_root/docs/$doc" "$pkgdir/usr/share/doc/ghost/docs/$doc"
  done
  install -Dm644 "$runtime_root/BUNDLED-LICENSES" \
    "$pkgdir/usr/share/licenses/$pkgname/runtime/BUNDLED-LICENSES"
  install_tree "$runtime_root/licenses" \
    "$pkgdir/usr/share/licenses/$pkgname/runtime/licenses"
  # The installed docs link the notices next to the docs directory.
  ln -s "/usr/share/licenses/$pkgname/THIRD_PARTY_NOTICES.md" \
    "$pkgdir/usr/share/doc/ghost/THIRD_PARTY_NOTICES.md"
else
  # The HUD is an omarchy-shell plugin. The package owns the files; the per-user
  # symlink into ~/.config/omarchy/plugins belongs to the install script, because
  # a package may not write into a home.
  install_tree "$source_root/packages/shell/qml" "$sharedir/plugin"

  install -Dm644 "$source_root/packages/shell/contrib/ghost.desktop" \
    "$pkgdir/usr/share/applications/ghost.desktop"
  install -Dm644 "$source_root/packages/shell/contrib/icons/ghost.svg" \
    "$pkgdir/usr/share/icons/hicolor/scalable/apps/ghost.svg"
  for size in 48 128 256; do
    install -Dm644 "$source_root/packages/shell/contrib/icons/ghost-$size.png" \
      "$pkgdir/usr/share/icons/hicolor/${size}x${size}/apps/ghost.png"
  done
  install_tree "$source_root/packages/shell/contrib" \
    "$pkgdir/usr/share/doc/ghost/shell-contrib"
fi

install -Dm644 "$source_root/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
install -Dm644 "$source_root/THIRD_PARTY_NOTICES.md" \
  "$pkgdir/usr/share/licenses/$pkgname/THIRD_PARTY_NOTICES.md"
chown -hR 0:0 "$pkgdir"
find "$pkgdir" \( -type f -o -type d \) -exec chmod go-w {} +

bash "$source_root/packaging/arch/smoke.sh" "$pkgdir" "$component"
