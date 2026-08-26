#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: prepare-pnpm-engine.sh <source-root>}"
source_root="$(realpath "$source_root")"

required="$(bun -e '
  const manifest = await Bun.file(process.argv[1]).json();
  const match = /^pnpm@(.+)$/.exec(manifest.packageManager ?? "");
  if (!match) process.exit(1);
  process.stdout.write(match[1]);
' "$source_root/package.json")"
actual="$(
  cd -- "$source_root"
  pnpm --version
)"
[[ "$actual" == "$required" ]] || {
  printf 'ghost requires pnpm %s, resolved %s\n' "$required" "$actual" >&2
  exit 1
}

pnpm_bin="$(
  cd -- "$source_root"
  pnpm exec sh -c 'command -v pnpm'
)"
pnpm_bin="$(realpath "$pnpm_bin")"
[[ -f "$pnpm_bin" && -x "$pnpm_bin" ]] || {
  printf 'prepared pnpm engine is not an executable file: %s\n' \
    "$pnpm_bin" >&2
  exit 1
}
[[ "$(npm_config_manage_package_manager_versions=false \
  "$pnpm_bin" --version)" == "$required" ]]

printf 'Prepared pnpm %s at %s\n' "$required" "$pnpm_bin"
