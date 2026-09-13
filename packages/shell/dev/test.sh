#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

node test/fixtures/mock-ghostd-parity-probe.mjs
node test/fixtures/mock-mcp-url-sanitizer-probe.mjs
node test/fixtures/transcript-role-probe.mjs

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

for candidate in "${QML:-}" /usr/lib/qt6/bin/qml /usr/bin/qml qml6; do
  if [[ -n $candidate ]] && command -v "$candidate" >/dev/null 2>&1; then
    QML=$candidate
    break
  fi
done
if [[ -z ${QML:-} ]]; then
  echo "no Qt6 qml runtime found" >&2
  exit 1
fi

node test/fixtures/hook-resource-probe.mjs "$QML"

sse_tmp=$(mktemp -d "${TMPDIR:-/tmp}/ghost-shell-sse.XXXXXX")
sse_url_file="$sse_tmp/url"
sse_pid=""
cleanup_sse() {
  if [[ -n $sse_pid ]] && kill -0 "$sse_pid" 2>/dev/null; then
    kill "$sse_pid"
    wait "$sse_pid" || true
  fi
  rmdir "$sse_tmp" 2>/dev/null || true
}
trap cleanup_sse EXIT

node test/fixtures/sse-byte-split-server.mjs "$sse_url_file" &
sse_pid=$!
for _ in {1..100}; do
  [[ -s $sse_url_file ]] && break
  kill -0 "$sse_pid" 2>/dev/null || break
  sleep 0.02
done
if [[ ! -s $sse_url_file ]]; then
  echo "byte-split SSE fixture did not start" >&2
  exit 1
fi
read -r sse_url < "$sse_url_file"
QT_QPA_PLATFORM=offscreen \
  "$QML" -I test/imports -I qml -I .qmllint \
    test/xhr-sse-unicode-probe.qml -- "$sse_url"

kill "$sse_pid"
wait "$sse_pid"
sse_pid=""
rmdir "$sse_tmp"
trap - EXIT

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

# Hook labels originate in trusted machine configuration but still remain
# display-only text. AutoText must never turn them into a resource surface.
hooks_view=qml/components/HooksBrowser.qml
rg -q 'textFormat: Text\.PlainText' "$hooks_view"
if rg -q 'Text\.(MarkdownText|RichText)|TextEdit\.(MarkdownText|RichText)|onLinkActivated|\b(Image|AnimatedImage|BorderImage|CodeView|FileView|FilePane)\s*\{' "$hooks_view"; then
  echo "HooksBrowser must expose only literal Text.PlainText labels" >&2
  exit 1
fi
