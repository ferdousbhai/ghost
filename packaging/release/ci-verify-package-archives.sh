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
# shellcheck source=ci-checkout-isolation.sh
source "$script_dir/ci-checkout-isolation.sh"
ghost_ci_validate_release_paths
release_out="$GHOST_CI_RELEASE_OUT"

isolation_parent="$(mktemp -d -p /var/tmp ghost-package-isolation.XXXXXX)"
checkout_isolated=0
restore_checkout() {
  if (( checkout_isolated )) || \
      [[ "${GHOST_CI_ISOLATION_CREATED:-0}" == 1 ]]; then
    ghost_ci_restore_checkout "$workspace" || return 1
    checkout_isolated=0
  fi
}
cleanup() {
  local status=$?
  trap - EXIT HUP INT TERM
  if ! restore_checkout; then
    printf 'checkout restoration failed; isolation state retained at %s\n' \
      "$(ghost_ci_isolation_path "$workspace")" >&2
    exit 1
  fi
  find -P "$isolation_parent" -depth -delete || exit 1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

smoke_copy="$isolation_parent/smoke.sh"
cp -- "$workspace/packaging/arch/smoke.sh" "$smoke_copy"
# The smoke test byte-compares the packaged launcher against the checked-in one,
# so the reference must travel with the script past ghost_ci_hide_checkout.
cp -- "$workspace/packaging/arch/ghostd" "$isolation_parent/ghostd"
mapfile -t archives < <(
  find "$release_out" -maxdepth 1 -type f \
    -name '*.pkg.tar.zst' -print | LC_ALL=C sort
)
[[ "${#archives[@]}" -eq 2 ]]
bash "$workspace/packaging/release/verify-package-archive-ownership.sh" \
  "${archives[@]}"
roots=()
for index in "${!archives[@]}"; do
  root="$isolation_parent/root-$index"
  mkdir -- "$root"
  bsdtar -xf "${archives[$index]}" -C "$root"
  roots+=("$root")
done

if ! ghost_ci_hide_checkout "$workspace"; then
  if [[ "${GHOST_CI_ISOLATION_CREATED:-0}" == 1 ]]; then
    checkout_isolated=1
  fi
  exit 1
fi
checkout_isolated=1
for root in "${roots[@]}"; do
  bash "$smoke_copy" "$root"
done
restore_checkout
