#!/usr/bin/env bash
# The ghost-core / ghost-omarchy split, proved on every lint run.
#
# ghost-core (the daemon) is everything a second interface could
# reuse. Core meets Omarchy only through HTTP/SSE and desktop MCP stdio, so it must
# never depend on or import Omarchy-side code, and the Omarchy side must never
# import core sources (it consumes the API and protocols instead). The root
# manifest pins ghost-desktop only so the runtime build can bundle it; that is
# packaging, and string references to its binary are the spawn seam.
set -euo pipefail
cd -- "$(git rev-parse --show-toplevel)"

fail=0

manifest=packages/daemon/package.json
if grep -Eq '"(@ghost/omarchy|ghost-desktop)"' "$manifest"; then
  printf 'core-boundary: %s depends on the Omarchy side\n' "$manifest" >&2
  fail=1
fi

if grep -rEn --include='*.ts' --include='*.js' --include='*.mjs' -e "(from|import|require)[[:space:]]*\\(?[\"'](@ghost/omarchy|ghost-desktop)" \
    packages/daemon/src 2>/dev/null; then
  printf 'core-boundary: core imports the Omarchy side (see above)\n' >&2
  fail=1
fi

if grep -rEn --include='*.qml' --include='*.js' --include='*.mjs' --include='*.ts' -e "(from|import|require)[[:space:]]*\\(?[\"'](@ghost/daemon|(\\.\\./)+daemon/)" \
    packages/shell 2>/dev/null; then
  printf 'core-boundary: the Omarchy side imports core sources (see above)\n' >&2
  fail=1
fi

exit "$fail"
