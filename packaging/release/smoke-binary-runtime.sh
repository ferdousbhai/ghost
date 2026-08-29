#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=offline-env.sh
source "$script_dir/offline-env.sh"

usage='smoke-binary-runtime.sh <ghostd-binary> <ghost-binary> <version> <scratch-root>'
daemon_binary="${1:?usage: $usage}"
client_binary="${2:?usage: $usage}"
version="${3:?usage: $usage}"
scratch="${4:?usage: $usage}"

daemon_binary="$(realpath "$daemon_binary")"
client_binary="$(realpath "$client_binary")"
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

help_output="$(env "${offline_env[@]}" timeout 20 "$daemon_binary" --help)"
grep -Fq 'Usage:' <<< "$help_output"
grep -Fq 'ghostd [options]' <<< "$help_output"

version_output="$(env "${offline_env[@]}" timeout 20 "$daemon_binary" --version)"
[[ "$version_output" == "$version" ]] || {
  printf 'ghostd returned version %s, expected %s\n' \
    "$version_output" "$version" >&2
  exit 1
}

help_output="$(env "${offline_env[@]}" timeout 20 "$client_binary" --help)"
grep -Fq 'Usage:' <<< "$help_output"
grep -Fq 'ghost <verb>' <<< "$help_output"

version_output="$(env "${offline_env[@]}" timeout 20 "$client_binary" --version)"
[[ "$version_output" == "$version" ]] || {
  printf 'ghost returned version %s, expected %s\n' \
    "$version_output" "$version" >&2
  exit 1
}

printf 'Compiled ghostd and ghost smoke test passed: %s %s\n' \
  "$daemon_binary" "$client_binary"
