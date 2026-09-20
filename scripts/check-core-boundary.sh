#!/usr/bin/env bash
# The ghost-core / ghost-omarchy split, proved on every lint run.
#
# ghost-core (daemon, extensions) is everything a second interface could
# reuse. The relay extension is a separate product that meets core only at
# the relay WebSocket protocol (see packages/chromium-extension/PROTOCOL.md);
# while its sources travel in this tree the checks below still cover them.
# Core meets the Omarchy side (@ghost/omarchy, the desktop helper) only at
# the seams CONTRACTS.md names — the daemon HTTP/SSE API, the relay WebSocket
# protocol, and the helper JSON-lines protocol with its PATH spawn — so core
# must never depend on or import Omarchy-side code, and the Omarchy side must
# never import core sources (it consumes the API and protocols instead).
# String references to the helper binary are the spawn seam, not imports,
# and do not count.
set -euo pipefail
cd -- "$(git rev-parse --show-toplevel)"

fail=0

for manifest in packages/daemon/package.json packages/extensions/package.json packages/chromium-extension/package.json; do
  if [[ -f "$manifest" ]] && grep -Eq '"@ghost/(omarchy|shell)"' "$manifest"; then
    printf 'core-boundary: %s depends on the Omarchy side\n' "$manifest" >&2
    fail=1
  fi
done

if grep -rEn --include='*.ts' --include='*.js' --include='*.mjs' -e "(from|import|require)[[:space:]]*\\(?[\"']@ghost/(omarchy|shell)" \
    packages/daemon/src packages/extensions/src packages/chromium-extension/extension packages/chromium-extension/test 2>/dev/null; then
  printf 'core-boundary: core imports the Omarchy side (see above)\n' >&2
  fail=1
fi

if grep -rEn --include='*.qml' --include='*.js' --include='*.mjs' -e "(from|import|require)[[:space:]]*\\(?[\"'](@ghost/daemon|@ghost/extensions|\\.\\./(daemon|extensions))" \
    packages/shell 2>/dev/null; then
  printf 'core-boundary: the Omarchy side imports core sources (see above)\n' >&2
  fail=1
fi

exit "$fail"
