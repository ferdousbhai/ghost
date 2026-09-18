#!/usr/bin/env bash
set -euo pipefail

root="${1:?usage: smoke.sh <package-root> <runtime|ui>}"
component="${2:?usage: smoke.sh <package-root> <runtime|ui>}"
[[ "$component" == runtime || "$component" == ui ]] || exit 2

require_file() {
  local path="$root$1"
  if [[ ! -f "$path" ]]; then
    printf 'missing packaged file: %s\n' "$1" >&2
    return 1
  fi
}

require_executable() {
  require_file "$1"
  if [[ ! -x "$root$1" ]]; then
    printf 'packaged file is not executable: %s\n' "$1" >&2
    return 1
  fi
}

require_unit_directive() {
  local unit="$root$1"
  local section="$2"
  local directive="$3"
  local value="$4"
  local expected="[$section]"$'\t'"$directive=$value"
  local matches=()
  mapfile -t matches < <(awk -v directive="$directive" '
    {
      line = $0
      sub(/^[[:space:]]+/, "", line)
      if (line ~ /^\[[^]]+\]$/) {
        section = line
        next
      }
      if (index(line, directive "=") == 1) print section "\t" line
    }
  ' "$unit")
  if (( ${#matches[@]} != 1 )) || [[ "${matches[0]-}" != "$expected" ]]; then
    printf 'packaged unit has an invalid %s directive: %s\n' "$directive" "$1" >&2
    return 1
  fi
}

data_files=()
executables=()
if [[ "$component" == runtime ]]; then
  data_files=(
    /usr/lib/ghost/desktop-helper/ghost_desktop_helper/__main__.py
    /usr/lib/ghost/desktop-helper/ghost_desktop_helper/_vendor/omaharness/LICENSE
    /usr/share/ghost/chromium-extension/manifest.json
    /usr/lib/systemd/user/ghostd.service
    /usr/lib/ghost/runtime/ghostd.js
    /usr/lib/ghost/runtime/ghost.js
    /usr/lib/ghost/runtime/photon_rs_bg.wasm
    /usr/share/doc/ghost/docs/hooks.md
  )
  executables=(/usr/bin/ghostd /usr/bin/ghost /usr/bin/ghost-desktop-helper
    /usr/lib/ghost/package-smoke/service-browser-smoke.sh)
  absent=(/usr/share/ghost/plugin /usr/share/applications/ghost.desktop
    /usr/share/icons /usr/share/doc/ghost/shell-contrib)
else
  data_files=(
    /usr/share/ghost/plugin/manifest.json
    /usr/share/ghost/plugin/Panel.qml
    /usr/share/ghost/plugin/Service.qml
    /usr/share/applications/ghost.desktop
    /usr/share/icons/hicolor/scalable/apps/ghost.svg
    /usr/share/icons/hicolor/128x128/apps/ghost.png
  )
  absent=(/usr/bin /usr/lib/ghost /usr/lib/systemd /usr/share/ghost/chromium-extension
    /usr/share/doc/ghost/README.md)
fi
for path in "${absent[@]}"; do
  if [[ -e "$root$path" || -L "$root$path" ]]; then
    printf '%s package contains another component: %s\n' "$component" "$path" >&2
    exit 1
  fi
done
for path in "${data_files[@]}"; do
  require_file "$path"
  [[ "$(stat -c '%a' "$root$path")" == 644 ]] || exit 1
done
for path in "${executables[@]}"; do
  require_executable "$path"
  [[ "$(stat -c '%a' "$root$path")" == 755 ]] || exit 1
done

# Numeric ownership is checked on the package archive itself. An unprivileged
# extraction deliberately owns its materialized tree and cannot preserve root.
if find "$root" -xdev \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
  printf 'package payload contains a group/world-writable path\n' >&2
  exit 1
fi
# The HUD is an omarchy-shell plugin: the package owns the files and the
# install script makes the per-user link, so there is no system-wide link.
if [[ -e "$root/etc/xdg/quickshell/ghost" ]]; then
  printf 'package still installs a system Quickshell config link\n' >&2
  exit 1
fi

if [[ "$component" == ui ]]; then
  desktop-file-validate "$root/usr/share/applications/ghost.desktop"
  python -m json.tool "$root/usr/share/ghost/plugin/manifest.json" >/dev/null
else
  python -m json.tool "$root/usr/share/ghost/chromium-extension/manifest.json" >/dev/null
  PYTHONDONTWRITEBYTECODE=1 \
  PYTHONPATH="$root/usr/lib/ghost/desktop-helper" \
    python -c 'import PIL; import ghost_desktop_helper._vendor.omaharness'
  if [[ -e "$root/usr/lib/ghost/desktop-helper/omaharness" ]]; then
    printf 'package payload exposes the private harness as top-level omaharness\n' >&2
    exit 1
  fi
  if find "$root/usr/lib/ghost/desktop-helper" \
    \( -type d -name __pycache__ -o -type f \( -name '*.pyc' -o -name '*.pyo' \) \) \
    -print -quit | grep -q .; then
    printf 'package payload contains generated Python bytecode\n' >&2
    exit 1
  fi
  GHOST_BUN_EXECUTABLE="$(command -v bun)" \
    "$root/usr/bin/ghostd" --version | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'

  mapfile -t runtime_license_manifests < <(
    find "$root/usr/share/licenses" -path '*/runtime/BUNDLED-LICENSES' -type f -print
  )
  if (( ${#runtime_license_manifests[@]} != 1 )); then
    printf 'package payload has %s bundled-license manifests, expected one\n' \
      "${#runtime_license_manifests[@]}" >&2
    exit 1
  fi
  runtime_license_root="$(dirname "${runtime_license_manifests[0]}")"
  require_runtime_license() {
    local path="$runtime_license_root/$1"
    [[ -f "$path" && "$(stat -c '%a' "$path")" == 644 ]] || {
      printf 'packaged runtime license is missing or unsafe: %s\n' "$1" >&2
      exit 1
    }
  }
  require_runtime_license licenses/ghost/LICENSE
  require_runtime_license licenses/ghost/THIRD_PARTY_NOTICES.md
  require_runtime_license licenses/npm/@earendil-works/pi-ai/0.84.3/LICENSE

  require_unit_directive /usr/lib/systemd/user/ghostd.service Unit PartOf \
    graphical-session.target
  require_unit_directive /usr/lib/systemd/user/ghostd.service Install WantedBy \
    graphical-session.target
  require_unit_directive /usr/lib/systemd/user/ghostd.service Service ReadWritePaths '%h %t'
  require_unit_directive /usr/lib/systemd/user/ghostd.service Service WorkingDirectory '%h'
  require_unit_directive /usr/lib/systemd/user/ghostd.service Service ExecStart /usr/bin/ghostd
  require_unit_directive /usr/lib/systemd/user/ghostd.service Service NoNewPrivileges yes
  if grep -Eq '^[[:space:]]*RestrictNamespaces=' \
    "$root/usr/lib/systemd/user/ghostd.service"; then
    printf 'ghostd.service blocks namespaces required by the Chromium sandbox\n' >&2
    exit 1
  fi

fi

# Every symlink in the installed payload must resolve inside that payload.
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  if [[ "$target" == /* ]]; then
    resolved="$(realpath -m "$root$target")"
  else
    resolved="$(realpath -m "$(dirname "$link")/$target")"
  fi
  case "$resolved" in
    "$root"/*) ;;
    *)
      printf 'packaged symlink escapes payload: %s -> %s\n' "${link#"$root"}" "$resolved" >&2
      exit 1
      ;;
  esac
  if [[ ! -e "$resolved" ]]; then
    printf 'packaged symlink is broken: %s\n' "${link#"$root"}" >&2
    exit 1
  fi
done < <(find "$root" -type l -print0)

if find "$root" -path '*/ghosts/*' -print -quit | grep -q .; then
  printf 'package payload must not own a user ghosts directory\n' >&2
  exit 1
fi

printf 'Ghost %s package smoke test passed: %s\n' "$component" "$root"
