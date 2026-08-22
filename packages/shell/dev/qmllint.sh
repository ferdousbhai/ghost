#!/usr/bin/env bash
# Lint every QML file in the package.
#
# The important part is finding the right binary. On Arch (and so on Omarchy)
# `/usr/bin/qmllint` is a **Qt 5 stub that exits 0 on any input** — it accepts
# misspelled properties and unknown types without a word. Always the Qt 6 one.
#
# `-I .qmllint` resolves the `qs.services` / `qs.components` module URIs.
# Quickshell synthesises a `qs` module rooted at the config directory at
# runtime; qmllint knows nothing about that, so `.qmllint/qs` is a symlink back
# to `qml/` that gives the same mapping through a normal import path.
set -euo pipefail

cd "$(dirname "$0")/.."

for candidate in qmllint6 /usr/lib/qt6/bin/qmllint /usr/lib/qt6/qmllint; do
  if command -v "$candidate" >/dev/null 2>&1; then QMLLINT=$candidate; break; fi
done

if [[ -z ${QMLLINT:-} ]]; then
  echo "no Qt6 qmllint found (looked for qmllint6, /usr/lib/qt6/bin/qmllint)" >&2
  echo "note: /usr/bin/qmllint on Arch is a Qt5 stub and must not be used" >&2
  exit 1
fi

version=$("$QMLLINT" --version)
case $version in
  *" 6."*) ;;
  *) echo "$QMLLINT is '$version', expected Qt 6" >&2; exit 1 ;;
esac

echo "$QMLLINT ($version)"
exec "$QMLLINT" -I .qmllint \
  qml/shell.qml \
  qml/GhostHud.qml \
  qml/GhostBarWidget.qml \
  qml/GhostBarSurface.qml \
  qml/components/*.qml \
  qml/services/*.qml \
  contrib/omarchy/bar-modules/*.qml
