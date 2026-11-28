#!/usr/bin/env bash
# Publishes the page to summonghost.com: a Cloudflare Worker that only serves
# public/, deployed with Cloudflare's `cf` (cloudflare.config.ts; never wrangler
# by hand). On the owner's go only.
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

cd -- "$here"
# cf and the wrangler it builds with, at the versions the lockfile names.
pnpm install --frozen-lockfile --silent
pnpm exec cf deploy "${dry_run[@]}" --message "ghost $(git -C "$root" rev-parse --short HEAD)"
