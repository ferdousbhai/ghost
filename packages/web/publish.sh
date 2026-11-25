#!/usr/bin/env bash
# Publishes the page to summonghost.com. The CloudChef project
# ferdous/summonghost only receives what this script sends: a push to its
# main is what publishes. Nothing is edited there.
#
#   packages/web/publish.sh             publish HEAD's packages/web
#   packages/web/publish.sh --dry-run   show what a publish would change
set -euo pipefail
here="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$here" rev-parse --show-toplevel)"
project=ferdous/summonghost
dry_run=""
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=1 ;;
  *) printf 'usage: packages/web/publish.sh [--dry-run]\n' >&2; exit 2 ;;
esac

# What is published is a commit, so the page can be traced back to it.
if [[ -n "$(git -C "$root" status --porcelain -- packages/web)" ]]; then
  printf 'publish: packages/web has uncommitted changes\n' >&2
  exit 1
fi
bash "$here/check.sh"

commit="$(git -C "$root" rev-parse --short HEAD)"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-web-publish.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
git clone --quiet --depth 1 "https://cloudchef.build/$project.git" "$work/site"

# The project holds exactly the served files and their Worker config.
git -C "$work/site" rm -r --quiet .
git -C "$root" archive HEAD:packages/web public wrangler.jsonc | tar -x -C "$work/site"
printf '%s\n' '# summonghost.com' '' \
  'The published copy of `packages/web` in <https://github.com/ferdousbhai/ghost>.' \
  'Change it there; `packages/web/publish.sh` replaces what is here.' > "$work/site/README.md"
git -C "$work/site" add -A

if git -C "$work/site" diff --cached --quiet; then
  printf 'summonghost.com already matches %s\n' "$commit"
  exit 0
fi
git -C "$work/site" diff --cached --stat
if [[ -n "$dry_run" ]]; then
  printf 'Dry run: nothing was pushed\n'
  exit 0
fi
git -C "$work/site" commit --quiet -m "Publish ghost $commit"
git -C "$work/site" push --quiet origin HEAD:main
cloudchef run watch --project "$project"
