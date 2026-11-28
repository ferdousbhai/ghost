#!/usr/bin/env bash
# Publishes the page to summonghost.com: a Cloudflare Worker with no script,
# which only serves public/ (worker.json is its settings). Deployed with
# Cloudflare's `cf` alone: this writes the Build Output `cf deploy --prebuilt`
# uploads, so there is no wrangler, no package.json and no node_modules here.
# On the owner's go only.
#
#   packages/web/publish.sh             publish HEAD's packages/web
#   packages/web/publish.sh --dry-run   build and check, upload nothing
set -euo pipefail
here="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
root="$(git -C "$here" rev-parse --show-toplevel)"
dry_run=()
case "${1:-}" in
  "") ;;
  --dry-run) dry_run=(--dry-run) ;;
  *) printf 'usage: packages/web/publish.sh [--dry-run]\n' >&2; exit 2 ;;
esac

# What is published is a commit, so the page can be traced back to it.
if [[ -n "$(git -C "$root" status --porcelain -- packages/web)" ]]; then
  printf 'publish: packages/web has uncommitted changes\n' >&2
  exit 1
fi
bash "$here/check.sh"

work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-web-publish.XXXXXX")"
trap 'rm -rf -- "$work"' EXIT
worker="$work/.cloudflare/output/v1/workers/default"
mkdir -p -- "$worker/assets"
git -C "$root" archive HEAD:packages/web/public | tar -x -C "$worker/assets"
git -C "$root" show HEAD:packages/web/worker.json > "$worker/worker.config.json"
printf '%s\n' '{"buildContext":{"isPreview":false}}' > "$work/.cloudflare/output/v1/config.json"

cd -- "$work"
cf deploy --prebuilt "${dry_run[@]}" --message "ghost $(git -C "$root" rev-parse --short HEAD)"
