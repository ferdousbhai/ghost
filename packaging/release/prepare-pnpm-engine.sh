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

# The launcher may delegate to the pinned engine. Its own path/version need
# not match: pnpm 12's `exec` resolves the launcher, not the delegated binary.
printf 'Prepared pnpm %s\n' "$actual"
