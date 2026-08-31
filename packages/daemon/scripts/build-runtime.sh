#!/usr/bin/env bash
set -euo pipefail

package_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
source_root="$(realpath "$package_root/../..")"
output="$package_root/dist/runtime"
work_parent="$package_root/dist"
cd -- "$source_root"

mkdir -p "$work_parent"
if [[ -L "$output" ]]; then
  printf 'runtime output must not be a symbolic link: %s\n' "$output" >&2
  exit 1
fi
work="$(mktemp -d "$work_parent/.runtime.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

runtime_root="$work/runtime"
meta_root="$work/meta"
mkdir -p "$runtime_root/bin" "$runtime_root/lib" "$meta_root"

version="$(bun -e \
  'process.stdout.write((await Bun.file(process.argv[1]).json()).version)' \
  "$package_root/package.json")"

build_bundle() {
  local entry="$1"
  local name="$2"
  bun build \
    --target=bun \
    --format=esm \
    --sourcemap=none \
    --define "process.env.GHOSTD_VERSION=\"$version\"" \
    --external fsevents \
    --external @anthropic-ai/claude-agent-sdk \
    --metafile="$meta_root/$name.json" \
    --outfile="$runtime_root/lib/$name.js" \
    "$package_root/$entry"
  chmod 644 "$runtime_root/lib/$name.js" "$meta_root/$name.json"
}

build_bundle src/main.ts ghostd
build_bundle src/cli/main.ts ghost
install -m755 "$package_root/scripts/launchers/ghostd" "$runtime_root/bin/ghostd"
install -m755 "$package_root/scripts/launchers/ghost" "$runtime_root/bin/ghost"

bun "$package_root/scripts/stage-runtime-assets.ts" \
  "$source_root" "$runtime_root" "$meta_root/ghostd.json"
bun "$package_root/scripts/stage-runtime-licenses.ts" \
  "$source_root" "$runtime_root" "$meta_root/ghostd.json" "$meta_root/ghost.json"
find -P "$runtime_root" -type d -exec chmod 755 {} +
find -P "$runtime_root" -type f ! -path "$runtime_root/bin/*" -exec chmod 644 {} +

if [[ -e "$output" ]]; then
  [[ -d "$output" ]] || {
    printf 'runtime output is not a directory: %s\n' "$output" >&2
    exit 1
  }
  find -P "$output" -depth -delete
fi
mv "$runtime_root" "$output"
trap - EXIT
find -P "$work" -depth -delete
