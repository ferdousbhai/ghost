#!/usr/bin/env bash
set -euo pipefail

root="${1:?usage: smoke.sh <package-root>}"
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

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

require_file /usr/lib/ghost/daemon/dist/main.js
require_file /usr/lib/ghost/daemon/package.json
require_file /usr/lib/ghost/desktop-helper/ghost_desktop_helper/__main__.py
require_file /usr/lib/ghost/desktop-helper/ghost_desktop_helper/_vendor/omaharness/LICENSE
require_file /usr/share/ghost/quickshell/shell.qml
require_file /usr/share/ghost/quickshell/tray/ghost-tray.py
require_file /usr/share/ghost/chromium-extension/manifest.json
require_file /usr/lib/systemd/user/ghostd.service
require_file /usr/lib/systemd/user/ghost-shell.service
require_file /usr/share/applications/ghost.desktop
# Installed documentation links into docs/; those targets must ship with it.
require_file /usr/share/doc/ghost/docs/keyring.md
require_file /usr/share/doc/ghost/docs/hooks.md
require_file /usr/share/doc/ghost/docs/claude-code-runtime.md
require_executable /usr/bin/ghostd
require_executable /usr/bin/ghost-desktop-helper
require_executable /usr/bin/ghost-launch
require_executable /usr/lib/ghost/package-smoke/service-browser-smoke.sh
require_executable /usr/lib/ghost/package-smoke/native-runtime-smoke.sh

# Numeric ownership is checked on the package archive itself. An unprivileged
# extraction deliberately owns its materialized tree and cannot preserve root.
if find "$root" -xdev \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
  printf 'package payload contains a group/world-writable path\n' >&2
  exit 1
fi
for path in \
  /usr/share/ghost/quickshell/shell.qml \
  /usr/share/ghost/chromium-extension/manifest.json \
  /usr/share/applications/ghost.desktop; do
  if [[ "$(stat -c '%a' "$root$path")" != 644 ]]; then
    printf 'packaged data file has an unsafe mode: %s\n' "$path" >&2
    exit 1
  fi
done
for path in \
  /usr/bin/ghostd \
  /usr/bin/ghost-desktop-helper \
  /usr/bin/ghost-launch \
  /usr/lib/ghost/package-smoke/service-browser-smoke.sh; do
  if [[ "$(stat -c '%a' "$root$path")" != 755 ]]; then
    printf 'packaged executable has an unsafe mode: %s\n' "$path" >&2
    exit 1
  fi
done

# Both recipes install the same checked-in launcher; a rewritten or generated
# copy would silently change the daemon's startup contract.
if ! cmp -s "$script_dir/ghostd" "$root/usr/bin/ghostd"; then
  printf 'packaged /usr/bin/ghostd differs from packaging/arch/ghostd\n' >&2
  exit 1
fi

if [[ "$(readlink "$root/etc/xdg/quickshell/ghost")" != "/usr/share/ghost/quickshell" ]]; then
  printf 'system Quickshell config link is missing or incorrect\n' >&2
  exit 1
fi

desktop-file-validate "$root/usr/share/applications/ghost.desktop"
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
bun "$root/usr/lib/ghost/daemon/dist/main.js" --version | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'

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
require_unit_directive /usr/lib/systemd/user/ghost-shell.service Service WorkingDirectory '%h'
require_unit_directive /usr/lib/systemd/user/ghost-shell.service Service ExecStart \
  '/usr/bin/qs -c ghost --no-duplicate'
require_unit_directive /usr/lib/systemd/user/ghost-shell.service Service ExecReload \
  '/usr/bin/qs -c ghost ipc call ghost refresh'

# Every symlink in the installed payload must resolve inside that payload.
# This catches pnpm workspace links back into the build checkout even while the
# checkout still exists, and rejects broken links after target-specific pruning.
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

smoke_parent="${GHOST_PACKAGE_SMOKE_WORK_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$smoke_parent"
native_scratch="$(mktemp -d "$smoke_parent/ghost-native-smoke.XXXXXX")"
cleanup() {
  find "$native_scratch" -depth -delete
}
trap cleanup EXIT
bash "$root/usr/lib/ghost/package-smoke/native-runtime-smoke.sh" \
  "$root/usr/lib/ghost/daemon" "$native_scratch"
cleanup
trap - EXIT

if find "$root" -path '*/ghosts/*' -print -quit | grep -q .; then
  printf 'package payload must not own a user ghosts directory\n' >&2
  exit 1
fi

printf 'Ghost package smoke test passed: %s\n' "$root"
