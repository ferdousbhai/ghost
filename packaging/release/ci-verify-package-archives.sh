#!/usr/bin/env bash

set -euo pipefail

(( EUID != 0 )) || {
  printf 'package archive verification must run as the package builder\n' >&2
  exit 1
}

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ci-release-paths.sh
source "$script_dir/ci-release-paths.sh"
ghost_ci_validate_release_paths
release_out="$GHOST_CI_RELEASE_OUT"

isolation_parent="$(mktemp -d -p /var/tmp ghost-package-isolation.XXXXXX)"
hidden_checkout=""
restore_checkout() {
  if [[ -n "$hidden_checkout" && -d "$hidden_checkout" ]]; then
    find "$hidden_checkout" -mindepth 1 -maxdepth 1 \
      -exec mv -t "$workspace" -- {} +
    rmdir -- "$hidden_checkout"
    hidden_checkout=""
  fi
}
cleanup() {
  restore_checkout
  find -P "$isolation_parent" -depth -delete
}
trap cleanup EXIT

smoke_copy="$isolation_parent/smoke.sh"
cp -- "$workspace/packaging/arch/smoke.sh" "$smoke_copy"
mapfile -t archives < <(
  find "$release_out" -maxdepth 1 -type f \
    -name '*.pkg.tar.zst' -print | LC_ALL=C sort
)
[[ "${#archives[@]}" -eq 2 ]]
roots=()
for index in "${!archives[@]}"; do
  root="$isolation_parent/root-$index"
  mkdir -- "$root"
  bsdtar -xf "${archives[$index]}" -C "$root"
  roots+=("$root")
done

hidden_checkout="$(mktemp -d -p /var/tmp ghost-hidden-checkout.XXXXXX)"
cd /var/tmp
find "$workspace" -mindepth 1 -maxdepth 1 \
  -exec mv -t "$hidden_checkout" -- {} +
for root in "${roots[@]}"; do
  bash "$smoke_copy" "$root"
done
restore_checkout
trap - EXIT
find -P "$isolation_parent" -depth -delete
