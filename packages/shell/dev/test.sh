#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

for candidate in "${QMLTESTRUNNER:-}" /usr/lib/qt6/bin/qmltestrunner /usr/lib/qt6/qmltestrunner qmltestrunner6; do
  if [[ -n $candidate ]] && command -v "$candidate" >/dev/null 2>&1; then
    QMLTESTRUNNER=$candidate
    break
  fi
done
if [[ -z ${QMLTESTRUNNER:-} ]]; then
  echo "no Qt6 qmltestrunner found" >&2
  exit 1
fi

# Loading qs.services materializes the Ghostd singleton, whose startup refresh
# is real I/O. The test-only Quickshell import maps GHOSTD_PORT to destination
# port 0, which cannot have a listener and therefore cannot reach an owner or
# unrelated process.
QT_QPA_PLATFORM=offscreen \
  "$QMLTESTRUNNER" -input test -import test/imports -import qml -import .qmllint -o -,txt

mapfile -t xdg_open_owners < <(rg -l '"xdg-open"' qml | sort)
if [[ ${#xdg_open_owners[@]} -ne 1 || ${xdg_open_owners[0]} != qml/services/ExternalLinks.qml ]]; then
  echo "xdg-open must be owned exclusively by qml/services/ExternalLinks.qml" >&2
  printf '%s\n' "${xdg_open_owners[@]}" >&2
  exit 1
fi

rg -q 'onLinkActivated: link => ExternalLinks\.openModelUrl\(link\)' qml/components/Bubble.qml
rg -q 'ExternalLinks\.openLoginUrl\(url\)' qml/services/Ghostd.qml
