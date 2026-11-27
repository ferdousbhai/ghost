#!/usr/bin/env bash
set -euo pipefail

root="${1:?usage: smoke.sh <package-root>}"

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

data_files=(
  /usr/lib/systemd/user/ghostd.service
  /usr/share/doc/ghost/docs/hooks.md
  /usr/share/applications/io.github.ferdousbhai.Ghost.desktop
  /usr/share/icons/hicolor/scalable/apps/ghost.svg
  /usr/share/icons/hicolor/128x128/apps/ghost.png
)
executables=(/usr/bin/ghostd /usr/bin/ghost /usr/bin/ghost-bar)
for path in "${data_files[@]}"; do
  require_file "$path"
  [[ "$(stat -c '%a' "$root$path")" == 644 ]] || exit 1
done
for path in "${executables[@]}"; do
  require_executable "$path"
  [[ "$(stat -c '%a' "$root$path")" == 755 ]] || exit 1
done

# Root ownership comes from install-payload.sh's chown under fakeroot; an
# unprivileged extraction owns its tree, so only the modes are checked here.
if find "$root" -xdev \( -type f -o -type d \) -perm /022 -print -quit | grep -q .; then
  printf 'package payload contains a group/world-writable path\n' >&2
  exit 1
fi

desktop-file-validate "$root/usr/share/applications/io.github.ferdousbhai.Ghost.desktop"
# Runs without a display or a daemon: the version is the release's, the same
# from all three, and printing it proves each binary loads its libraries.
version="$("$root/usr/bin/ghostd" --version)"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
[[ "$("$root/usr/bin/ghost" --version)" == "$version" && "$("$root/usr/bin/ghost-bar" --version)" == "$version" ]]

for license in LICENSE THIRD_PARTY_NOTICES.md; do
  require_file "$(cd "$root" && printf '/%s' usr/share/licenses/*/"$license")"
done

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

if find "$root" -path '*/.local/*' -print -quit | grep -q .; then
  printf 'package payload must not own a user ghost home\n' >&2
  exit 1
fi

printf 'Ghost package smoke test passed: %s\n' "$root"
