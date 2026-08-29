#!/usr/bin/env bash
# Compile ghostd and ghost into self-contained executables (Bun runtime included).
#
# Playwright's optional BiDi and Electron requires, and the macOS-only
# fsevents watcher, stay external: Ghost drives Chromium over CDP and never
# loads them, and Bun cannot embed modules it cannot resolve.
set -euo pipefail
cd -- "$(dirname "${BASH_SOURCE[0]}")/.."
version="$(bun -e 'process.stdout.write((await Bun.file("package.json").json()).version)')"
target="${GHOSTD_COMPILE_TARGET:-bun-linux-x64}"

build_binary() {
  local entry="$1"
  local outfile="$2"
  mkdir -p "$(dirname "$outfile")"
  bun build --compile --target="$target" \
    --define "process.env.GHOSTD_VERSION=\"$version\"" \
    --external 'chromium-bidi/*' --external electron --external fsevents \
    "$entry" --outfile "$outfile"
}

build_binary src/main.ts "${1:-dist/ghostd}"
build_binary src/cli/main.ts "${2:-dist/ghost}"
