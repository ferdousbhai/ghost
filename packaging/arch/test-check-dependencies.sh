#!/usr/bin/env bash

# Keep commands used by package checks, PKGBUILD metadata, the generated
# .SRCINFO, and the stable recipe's dependencies in agreement.

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_dir/../..")"
for script in arch-run.sh build-native.sh; do bash -n "$script_dir/$script"; done
temp_base="${TMPDIR:-/tmp}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-arch-dependencies.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

if (( EUID == 0 )); then
  printf 'package metadata parity must run as the unprivileged builder\n' >&2
  exit 1
fi

require_srcinfo_entry() {
  local field="$1"
  local package="$2"
  local srcinfo="$3"
  if ! grep -Fxq $'\t'"$field = $package" "$srcinfo"; then
    printf '%s does not declare %s = %s\n' "$srcinfo" "$field" "$package" >&2
    exit 1
  fi
}

require_srcinfo_dependency() {
  local package="$1"
  local srcinfo="$2"
  if ! grep -Eq $'^\tdepends = '"${package}([<>=]|\$)" "$srcinfo"; then
    printf '%s does not declare depends = %s\n' "$srcinfo" "$package" >&2
    exit 1
  fi
}

# Installing Ghost gates on nothing owner-level, so each hook has one job: say
# how to bring the services up on this login.
require_install_hook_activation() {
  local install_script="$1"
  local hook="$2"
  local service_command="$3"
  local output
  output="$(bash -c 'source "$1"; "$2"' ghost-install-hook "$install_script" "$hook")"
  if ! grep -Fq -- "$service_command" <<< "$output"; then
    printf '%s %s does not print %s\n' "$install_script" "$hook" "$service_command" >&2
    exit 1
  fi
}

command -v rg >/dev/null || {
  printf 'ripgrep is required by package checks but is not installed\n' >&2
  exit 1
}
command -v node >/dev/null || {
  printf 'nodejs is required by package checks but is not installed\n' >&2
  exit 1
}
command -v jq >/dev/null || {
  printf 'jq is required by the Omarchy contribution regression but is not installed\n' >&2
  exit 1
}
# makepkg needs each recipe's hooks as regular files beside it, so the two
# recipes keep identical copies.
cmp "$script_dir/ghost-dev.install" \
  "$source_root/packaging/omarchy/pkgbuilds/ghost/ghost.install"
cmp "$script_dir/ghost-runtime-dev.install" \
  "$source_root/packaging/omarchy/pkgbuilds/ghost/ghost-runtime.install"
install_script="$script_dir/ghost-runtime-dev.install"
require_install_hook_activation "$install_script" post_install \
  'systemctl --user enable --now ghostd.service'
require_install_hook_activation "$install_script" post_upgrade \
  'systemctl --user restart ghostd.service'

bash "$script_dir/test-split-payload.sh"
bash "$source_root/packaging/release/test-release-version.sh"
bash "$source_root/packaging/release/test-runtime-source.sh"
bash "$source_root/packaging/release/test-installer.sh"
bash "$source_root/packaging/omarchy/test-contribution.sh"

# Every packaging test suite must be invoked by some other packaging or CI
# file; an unreferenced test-* file is a suite that silently never runs.
while IFS= read -r suite; do
  name="$(basename -- "$suite")"
  if ! grep -rFq --exclude="$name" \
    --exclude='README.md' "$name" \
    "$source_root/packaging" "$source_root/.github"; then
    printf 'orphaned packaging test suite: %s is referenced nowhere\n' \
      "$suite" >&2
    exit 1
  fi
done < <(find "$source_root/packaging" \
  -name 'test-*' -type f -print | sort)

(
  CDPATH= cd -- "$script_dir"
  env -u GHOST_SOURCE_REPO -u GHOST_SOURCE_REF makepkg --printsrcinfo
) > "$work/ghost-dev.SRCINFO"
cmp "$script_dir/.SRCINFO" "$work/ghost-dev.SRCINFO"
require_srcinfo_entry checkdepends jq "$work/ghost-dev.SRCINFO"
require_srcinfo_entry checkdepends nodejs "$work/ghost-dev.SRCINFO"
require_srcinfo_entry checkdepends ripgrep "$work/ghost-dev.SRCINFO"
require_srcinfo_entry makedepends 'bun>=1.4.0' "$work/ghost-dev.SRCINFO"
require_srcinfo_dependency bun "$work/ghost-dev.SRCINFO"
require_srcinfo_entry optdepends 'npm: npx-launched MCP servers' "$work/ghost-dev.SRCINFO"
require_srcinfo_dependency systemd "$work/ghost-dev.SRCINFO"

bash "$source_root/packaging/release/render-arch-package.sh" \
  "$work/ghost" \
  0.0.1 \
  0000000000000000000000000000000000000000000000000000000000000000 \
  0000000000000000000000000000000000000000000000000000000000000000
# The stable recipe needs what the development one does at run and check
# time; only the development build itself needs git and pnpm.
dependencies() {
  sed -En 's/^\t(depends|checkdepends|optdepends) = /\1 /p' "$1" \
    | sed '/^depends ghost-runtime/d' | LC_ALL=C sort
}
if ! cmp <(dependencies "$work/ghost-dev.SRCINFO") <(dependencies "$work/ghost/.SRCINFO"); then
  printf 'stable and development dependencies differ\n' >&2
  exit 1
fi

printf 'Arch package check dependency coverage passed\n'
