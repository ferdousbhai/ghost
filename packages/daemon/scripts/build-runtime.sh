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
mkdir -p "$runtime_root/bin" "$runtime_root/lib"

version="$(bun -e \
  'process.stdout.write((await Bun.file(process.argv[1]).json()).version)' \
  "$source_root/package.json")"

# Ghost's bundles carry its release version.
build_bundle() {
  local entry="$1"
  local name="$2"
  shift 2
  bun build \
    --target=bun \
    --format=esm \
    --sourcemap=none \
    --minify \
    --keep-names \
    "$@" \
    --outfile="$runtime_root/lib/$name.js" \
    "$entry"
  chmod 644 "$runtime_root/lib/$name.js"
}

ghost_version=(--define "process.env.GHOSTD_VERSION=\"$version\"")
build_bundle "$package_root/src/main.ts" ghostd "${ghost_version[@]}"
build_bundle "$package_root/src/cli/main.ts" ghost "${ghost_version[@]}"
install -m755 "$package_root/scripts/launchers/launcher" "$runtime_root/bin/ghostd"
install -m755 "$package_root/scripts/launchers/launcher" "$runtime_root/bin/ghost"

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
