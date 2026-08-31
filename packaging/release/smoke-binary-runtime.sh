#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=offline-env.sh
source "$script_dir/offline-env.sh"

usage='smoke-binary-runtime.sh <ghostd-launcher> <ghost-launcher> <version> <scratch-root>'
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
  NO_PROXY="127.0.0.1,localhost"
  no_proxy="127.0.0.1,localhost"
  GHOST_BUN_EXECUTABLE="${GHOST_RUNTIME_SMOKE_BUN:-$(command -v bun)}"
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

if [[ "${GHOST_RUNTIME_FULL_SMOKE:-0}" == 1 ]]; then
  smoke_output="$(env "${offline_env[@]}" \
    GHOSTD="$daemon_binary" timeout 30 "$client_binary" smoke --no-turn)"
  grep -Fq 'ok daemon: ok' <<< "$smoke_output"
  grep -Fq 'ok new probe' <<< "$smoke_output"
  grep -Fq 'ok turn: skipped (--no-turn)' <<< "$smoke_output"
fi

printf 'Bun-bundled ghostd and ghost smoke test passed: %s %s\n' \
  "$daemon_binary" "$client_binary"
