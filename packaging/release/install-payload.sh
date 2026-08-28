#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: install-payload.sh <source-root> <runtime-daemon> <pkgdir> <pkgname>}"
runtime_daemon="${2:?usage: install-payload.sh <source-root> <runtime-daemon> <pkgdir> <pkgname>}"
pkgdir="${3:?usage: install-payload.sh <source-root> <runtime-daemon> <pkgdir> <pkgname>}"
pkgname="${4:?usage: install-payload.sh <source-root> <runtime-daemon> <pkgdir> <pkgname>}"

source_root="$(realpath "$source_root")"
runtime_daemon="$(realpath "$runtime_daemon")"

install_tree() {
  local source_dir="$1"
  local destination_dir="$2"
  local directory file link relative mode target

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
  while IFS= read -r -d '' link; do
    relative="${link#"$source_dir"/}"
    target="$(readlink "$link")"
    ln -s "$target" "$destination_dir/$relative"
  done < <(find "$source_dir" -type l -print0)
}

appdir="$pkgdir/usr/lib/ghost"
sharedir="$pkgdir/usr/share/ghost"

install_tree "$runtime_daemon" "$appdir/daemon"

install -Dm755 "$source_root/packaging/arch/ghostd" "$pkgdir/usr/bin/ghostd"
install -Dm755 "$source_root/packaging/arch/ghost-desktop-helper" \
  "$pkgdir/usr/bin/ghost-desktop-helper"
install -Dm755 "$source_root/packages/shell/contrib/bin/ghost-launch" \
  "$pkgdir/usr/bin/ghost-launch"

while IFS= read -r -d '' file; do
  install -Dm644 "$file" \
    "$appdir/desktop-helper/${file#"$source_root/packages/desktop-helper/src/"}"
done < <(find "$source_root/packages/desktop-helper/src" -type f \
  \( -name '*.py' -o -name LICENSE \) -print0)

install_tree "$source_root/packages/shell/qml" "$sharedir/quickshell"
install -d -m755 -o root -g root "$pkgdir/etc/xdg/quickshell"
ln -s /usr/share/ghost/quickshell "$pkgdir/etc/xdg/quickshell/ghost"

install_tree "$source_root/packages/chromium-extension/extension" \
  "$sharedir/chromium-extension"

install -Dm644 "$source_root/packages/daemon/contrib/ghostd.service" \
  "$pkgdir/usr/lib/systemd/user/ghostd.service"
install -Dm644 "$source_root/packages/shell/contrib/systemd/ghost-shell.service" \
  "$pkgdir/usr/lib/systemd/user/ghost-shell.service"
install -Dm644 "$source_root/packages/shell/contrib/ghost.desktop" \
  "$pkgdir/usr/share/applications/ghost.desktop"
install -Dm755 "$source_root/packaging/arch/service-browser-smoke.sh" \
  "$pkgdir/usr/lib/ghost/package-smoke/service-browser-smoke.sh"
install -Dm755 "$source_root/packaging/release/smoke-native-runtime.sh" \
  "$pkgdir/usr/lib/ghost/package-smoke/native-runtime-smoke.sh"

install_tree "$source_root/packages/shell/contrib" \
  "$pkgdir/usr/share/doc/ghost/shell-contrib"
install -Dm644 "$source_root/packaging/arch/README.md" \
  "$pkgdir/usr/share/doc/ghost/ARCH.md"
install -Dm644 "$source_root/packaging/release/README.md" \
  "$pkgdir/usr/share/doc/ghost/RELEASE-SOURCE.md"
install -Dm644 "$source_root/README.md" "$pkgdir/usr/share/doc/ghost/README.md"
install -Dm644 "$source_root/CONTRACTS.md" "$pkgdir/usr/share/doc/ghost/CONTRACTS.md"
# The installed README, CONTRACTS.md, and ARCH.md link into docs/. Ship those
# link targets so the relative references resolve inside the package.
for doc in claude-code-runtime.md hooks.md keyring.md; do
  install -Dm644 "$source_root/docs/$doc" "$pkgdir/usr/share/doc/ghost/docs/$doc"
done
install -Dm644 "$source_root/LICENSE" "$pkgdir/usr/share/licenses/$pkgname/LICENSE"
install -Dm644 "$source_root/THIRD_PARTY_NOTICES.md" \
  "$pkgdir/usr/share/licenses/$pkgname/THIRD_PARTY_NOTICES.md"
# docs/claude-code-runtime.md links the notices next to the docs directory.
ln -s "/usr/share/licenses/$pkgname/THIRD_PARTY_NOTICES.md" \
  "$pkgdir/usr/share/doc/ghost/THIRD_PARTY_NOTICES.md"

chown -hR 0:0 "$pkgdir"
find "$pkgdir" \( -type f -o -type d \) -exec chmod go-w {} +

bash "$source_root/packaging/arch/smoke.sh" "$pkgdir"
