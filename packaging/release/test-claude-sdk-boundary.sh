#!/usr/bin/env bash
set -euo pipefail

source_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
fixture="$source_root/packages/daemon/test/fixtures/claude-agent-sdk-release-boundary.ts"
install_fixture="$source_root/packaging/release/fixtures/claude-agent-sdk"
bun_bin="$(realpath -e -- "$(command -v bun)")"
pnpm_bin="$(realpath -e -- "$(command -v pnpm)")"
node_bin="$(realpath -e -- "$(command -v node)")"
store_dir="$(realpath -e -- "$(pnpm store path --silent)")"
scratch_parent="${GHOST_CLAUDE_SDK_BOUNDARY_TEST_ROOT:-${TMPDIR:-/tmp}}"

if [[ ! -d "$scratch_parent" || -L "$scratch_parent" ]]; then
  echo "Claude SDK boundary test root must be a real directory: $scratch_parent" >&2
  exit 1
fi

scratch_root="$(mktemp -d -p "$scratch_parent" ghost-claude-sdk-boundary.XXXXXX)"
chmod 700 "$scratch_root"
install -m 600 /dev/null "$scratch_root/.ghost-claude-sdk-boundary"
cleanup() {
  find -P "$scratch_root" -depth -delete
}
trap cleanup EXIT

owner_home="$scratch_root/home"
data_home="$scratch_root/data"
cache_home="$scratch_root/cache"
config_home="$scratch_root/config"
state_home="$scratch_root/state"
runtime_home="$scratch_root/runtime"
claude_home="$scratch_root/claude"
temp_home="$scratch_root/tmp"
install_root="$data_home/ghost/claude-agent-sdk/0.3.170"
install -d -m 700 \
  "$owner_home" "$data_home" "$cache_home" "$config_home" "$state_home" \
  "$runtime_home" "$claude_home" "$temp_home" "$install_root"

safe_path="$(dirname "$bun_bin"):$(dirname "$pnpm_bin"):$(dirname "$node_bin"):/usr/bin:/bin"
clean_env=(
  env -i
  "HOME=$owner_home"
  "XDG_DATA_HOME=$data_home"
  "XDG_CACHE_HOME=$cache_home"
  "XDG_CONFIG_HOME=$config_home"
  "XDG_STATE_HOME=$state_home"
  "XDG_RUNTIME_DIR=$runtime_home"
  "CLAUDE_CONFIG_DIR=$claude_home"
  "TMPDIR=$temp_home"
  "PATH=$safe_path"
  "ALL_PROXY=http://127.0.0.1:9"
  "HTTPS_PROXY=http://127.0.0.1:9"
  "HTTP_PROXY=http://127.0.0.1:9"
  "NO_PROXY="
  "all_proxy=http://127.0.0.1:9"
  "https_proxy=http://127.0.0.1:9"
  "http_proxy=http://127.0.0.1:9"
  "no_proxy="
)

"${clean_env[@]}" "$bun_bin" --bun "$fixture" \
  contract "$owner_home" "$data_home" "$scratch_root" "$source_root"
rmdir "$install_root"
"${clean_env[@]}" "$bun_bin" --bun "$fixture" \
  missing "$owner_home" "$data_home" "$scratch_root"
install -d -m 700 "$install_root"
install -m 600 \
  "$install_fixture/package.json" \
  "$install_fixture/pnpm-lock.yaml" \
  "$install_root/"

"${clean_env[@]}" "$pnpm_bin" install \
  --dir "$install_root" \
  --store-dir "$store_dir" \
  --config.trust-lockfile=true \
  --offline \
  --frozen-lockfile \
  --ignore-scripts \
  --ignore-workspace

"${clean_env[@]}" "$bun_bin" --bun "$fixture" \
  installed-remove "$owner_home" "$data_home" "$scratch_root"

echo "Claude Agent SDK external-boundary test passed"
