#!/usr/bin/env bash
# The page's checks (check.html), run in headless Chromium: the page has no
# build step and no other JavaScript engine is needed to work on it.
set -euo pipefail
here="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

chromium="${CHROMIUM:-$(command -v chromium || true)}"
[[ -n "$chromium" ]] || { printf 'web check: chromium is not installed\n' >&2; exit 1; }

scripts="$(cd "$here/public/js" && printf '%s,' *.js)"
profile="$(mktemp -d "${TMPDIR:-/tmp}/ghost-web-check.XXXXXX")"
trap 'rm -rf -- "$profile"' EXIT

# --allow-file-access-from-files lets the page load its modules from disk.
# The empty XDG_CONFIG_HOME keeps the owner's chromium-flags.conf (their
# profile, extensions and debugging port) out of this run.
dom="$(XDG_CONFIG_HOME="$profile" timeout 60 "$chromium" --headless --disable-gpu --no-sandbox \
  --user-data-dir="$profile/data" --allow-file-access-from-files \
  --dump-dom "file://$here/check.html?scripts=${scripts%,}" 2>/dev/null || true)"

if [[ "$dom" == *'data-check="passed"'* ]]; then
  printf 'Web check passed\n'
else
  found="$(sed -n 's|.*data-failures="\([^"]*\)".*|\1|p' <<<"$dom")"
  printf 'Web check failed: %s\n' "${found:-Chromium did not run the checks}" >&2
  exit 1
fi
