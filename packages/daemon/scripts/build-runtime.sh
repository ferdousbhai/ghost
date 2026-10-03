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

# Ghost's own bundles carry its release version; ghost-desktop, its own repo
# pinned in the root package.json, keeps the version it reports itself.
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
    --external fsevents \
    --metafile="$meta_root/$name.json" \
    --outfile="$runtime_root/lib/$name.js" \
    "$entry"
  chmod 644 "$runtime_root/lib/$name.js" "$meta_root/$name.json"
}

ghost_version=(--define "process.env.GHOSTD_VERSION=\"$version\"")
build_bundle "$package_root/src/main.ts" ghostd "${ghost_version[@]}"
build_bundle "$package_root/src/cli/main.ts" ghost "${ghost_version[@]}"
build_bundle "$source_root/node_modules/ghost-desktop/src/main.ts" ghost-desktop
install -m755 "$package_root/scripts/launchers/launcher" "$runtime_root/bin/ghostd"
install -m755 "$package_root/scripts/launchers/launcher" "$runtime_root/bin/ghost"
install -m755 "$package_root/scripts/launchers/launcher" "$runtime_root/bin/ghost-desktop"

bun "$package_root/scripts/stage-runtime-licenses.ts" \
  "$source_root" "$runtime_root" "$meta_root/ghostd.json" "$meta_root/ghost.json" \
  "$meta_root/ghost-desktop.json"
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
