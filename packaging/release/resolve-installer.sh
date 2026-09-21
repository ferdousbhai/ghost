#!/usr/bin/env bash
# What the public one-liner serves right now. ferdousbhai.com/ghost/install.sh
# redirects to the latest release's install.sh asset, so a release that fails
# verification and is rolled back leaves users with whatever the release
# before it carried, and the first release to carry install.sh leaves them
# with nothing. publish.sh asks before it tags, to know what a rollback would
# land on, and again after a rollback, to say what it landed on.
#
#   resolve-installer.sh [<owner/repo>]
#
# Follows the redirect chain with HEAD requests and prints the tag whose
# install.sh is served. Exit 0: that tag serves it. Exit 2: the chain reaches
# the latest release but it carries no install.sh, so the one-liner is a
# 404 (the tag is named on stderr). Exit 1: the chain does not pass through
# <owner/repo>'s latest-release asset at all, or the probe itself failed,
# which no release from here can fix.
#
# GHOST_INSTALL_URL and GHOST_RELEASES_URL point the probe at a fabricated
# chain for tests; the defaults are the public one-liner and GitHub.
set -euo pipefail

repository="${1:-ferdousbhai/ghost}"
url="${GHOST_INSTALL_URL:-https://ferdousbhai.com/ghost/install.sh}"
releases="${GHOST_RELEASES_URL:-https://github.com/$repository/releases}"

command -v curl >/dev/null || {
  printf 'curl is required to probe the public one-liner\n' >&2
  exit 1
}

# Every hop's headers, CRLF stripped: the last status line is the answer and
# the Location lines are the path it took.
headers="$(curl -sSIL --max-redirs 5 -- "$url" | tr -d '\r')" || {
  printf 'could not reach the public one-liner at %s\n' "$url" >&2
  exit 1
}
status="$(sed -n 's/^HTTP\/[0-9.]* \([0-9]\{3\}\).*/\1/p' <<< "$headers" | tail -n 1)"
grep -qi "^location: $releases/latest/download/install.sh\$" <<< "$headers" || {
  printf '%s does not redirect to %s/latest/download/install.sh (HTTP %s); a release cannot fix that\n' \
    "$url" "$releases" "${status:-none}" >&2
  exit 1
}
tag="$(sed -n "s#^[Ll]ocation: $releases/download/\([^/]\{1,\}\)/install.sh\$#\1#p" <<< "$headers" | head -n 1)"

case "$status" in
  200)
    [[ -n "$tag" ]] || {
      printf '%s serves install.sh from somewhere other than a %s release\n' "$url" "$repository" >&2
      exit 1
    }
    printf '%s\n' "$tag"
    ;;
  404)
    printf 'the public one-liner %s serves nothing: %s carries no install.sh\n' \
      "$url" "${tag:-the latest $repository release}" >&2
    exit 2
    ;;
  *)
    printf 'the public one-liner %s answered HTTP %s\n' "$url" "${status:-nothing}" >&2
    exit 1
    ;;
esac
