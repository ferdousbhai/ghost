#!/usr/bin/env bash
# Compile ghostd into one self-contained executable (Bun runtime included).
#
# Playwright's optional BiDi and Electron requires, and the macOS-only
# fsevents watcher, stay external: Ghost drives Chromium over CDP and never
# loads them, and Bun cannot embed modules it cannot resolve.
set -euo pipefail
cd -- "$(dirname "${BASH_SOURCE[0]}")/.."
version="$(bun -e 'process.stdout.write((await Bun.file("package.json").json()).version)')"
target="${GHOSTD_COMPILE_TARGET:-bun-linux-x64}"
outfile="${1:-dist/ghostd}"
mkdir -p "$(dirname "$outfile")"
bun build --compile --target="$target" \
  --define "process.env.GHOSTD_VERSION=\"$version\"" \
  --external 'chromium-bidi/*' --external electron --external fsevents \
  src/main.ts --outfile "$outfile"
