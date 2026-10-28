#!/usr/bin/env bash
# Render every Ghost surface to dev/render/out/*.png from fixed sample data,
# offscreen, through the test runner and its stubs: no desktop, daemon, or
# window is touched. Look at the PNGs to review a visual change.
set -euo pipefail
cd "$(dirname "$0")/.."
for candidate in "${QMLTESTRUNNER:-}" /usr/lib/qt6/bin/qmltestrunner /usr/lib/qt6/qmltestrunner qmltestrunner6; do
  if [[ -n $candidate ]] && command -v "$candidate" >/dev/null 2>&1; then QMLTESTRUNNER=$candidate; break; fi
done
[[ -n ${QMLTESTRUNNER:-} ]] || { echo "no Qt6 qmltestrunner found" >&2; exit 1; }
rm -rf dev/render/out
mkdir -p dev/render/out
QT_QPA_PLATFORM=offscreen "$QMLTESTRUNNER" -input dev/render/tst_render.qml -import test/imports -import qml -o -,txt \
  | grep -E '^(FAIL|Totals)' || true
ls dev/render/out
