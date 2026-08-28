#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=offline-env.sh
source "$script_dir/offline-env.sh"

binary="${1:?usage: smoke-binary-runtime.sh <ghostd-binary> <version> <scratch-root>}"
version="${2:?usage: smoke-binary-runtime.sh <ghostd-binary> <version> <scratch-root>}"
scratch="${3:?usage: smoke-binary-runtime.sh <ghostd-binary> <version> <scratch-root>}"

binary="$(realpath "$binary")"
install -d -m700 \
  "$scratch/home" \
  "$scratch/state" \
  "$scratch/config" \
  "$scratch/cache"

offline_env=(
  HOME="$scratch/home"
  XDG_STATE_HOME="$scratch/state"
  XDG_CONFIG_HOME="$scratch/config"
  XDG_CACHE_HOME="$scratch/cache"
)

help_output="$(env "${offline_env[@]}" timeout 20 "$binary" --help)"
grep -Fq 'Usage:' <<< "$help_output"
grep -Fq 'ghostd [options]' <<< "$help_output"

version_output="$(env "${offline_env[@]}" timeout 20 "$binary" --version)"
[[ "$version_output" == "$version" ]] || {
  printf 'ghostd returned version %s, expected %s\n' \
    "$version_output" "$version" >&2
  exit 1
}

printf 'Compiled ghostd smoke test passed: %s\n' "$binary"
