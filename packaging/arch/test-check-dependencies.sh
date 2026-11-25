#!/usr/bin/env bash

# The packaging checks: the install hooks, the staged payload, the release
# version, the installer, the Omarchy contribution, and the rendered recipe.

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

command -v jq >/dev/null || {
  printf 'jq is required by the Omarchy contribution regression but is not installed\n' >&2
  exit 1
}
install_script="$source_root/packaging/omarchy/pkgbuilds/ghost/ghost.install"
require_install_hook_activation "$install_script" post_install \
  'systemctl --user enable --now ghostd.service'
require_install_hook_activation "$install_script" post_upgrade \
  'systemctl --user restart ghostd.service'

bash "$script_dir/test-payload.sh"
bash "$source_root/packaging/release/test-release-version.sh"
bash "$source_root/packaging/release/test-install-script.sh"
bash "$source_root/packaging/omarchy/test-contribution.sh"

# Every packaging test suite must be invoked by some other packaging, gate or
# CI file; an unreferenced test-* file is a suite that silently never runs.
while IFS= read -r suite; do
  name="$(basename -- "$suite")"
  if ! grep -rFq --exclude="$name" \
    --exclude='README.md' "$name" \
    "$source_root/packaging" "$source_root/.github" "$source_root/.githooks"; then
    printf 'orphaned packaging test suite: %s is referenced nowhere\n' \
      "$suite" >&2
    exit 1
  fi
done < <(find "$source_root/packaging" \
  -name 'test-*' -type f -print | sort)

bash "$source_root/packaging/release/render-arch-package.sh" \
  "$work/ghost" \
  0.0.1 \
  0000000000000000000000000000000000000000000000000000000000000000
[[ "$(stat -c '%a' "$work/ghost/.SRCINFO")" == 644 ]]
# The commands the checks and the turn prompt call are declared: jq here, and
# in the local model's Claude command (coding_agent.rs).
require_srcinfo_entry checkdepends jq "$work/ghost/.SRCINFO"
require_srcinfo_entry depends jq "$work/ghost/.SRCINFO"

printf 'Packaging checks passed\n'
