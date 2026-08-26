#!/usr/bin/bash

set -euo pipefail

(( EUID != 0 )) || {
  printf 'checkout isolation regression must run unprivileged\n' >&2
  exit 1
}

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ci-checkout-isolation.sh
source "$script_dir/ci-checkout-isolation.sh"
test_root="${GHOST_CI_ISOLATION_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p -- "$test_root"
work="$(mktemp -d "$test_root/ghost-checkout-isolation.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

workspace="$work/workspace with newline fixture"
mkdir -- "$workspace"
newline_name=$'line\nbreak'
entries=(.dotfile "$newline_name" directory source-target runtime-link sparse-image)
printf 'dot\n' > "$workspace/.dotfile"
printf 'newline\n' > "$workspace/$newline_name"
mkdir -- "$workspace/directory"
printf 'nested\n' > "$workspace/directory/file"
printf 'absolute target\n' > "$workspace/source-target"
ln -s -- "$workspace/source-target" "$workspace/runtime-link"
truncate -s 8G -- "$workspace/sparse-image"

inventory() {
  local name path
  for name in "${entries[@]}" directory/file; do
    path="$workspace/$name"
    if [[ -L "$path" ]]; then
      printf '%q\t%s\t%s\n' "$name" \
        "$(stat -c '%d:%i:%f:%s:%b' -- "$path")" \
        "$(readlink -- "$path")"
    elif [[ -f "$path" && "$name" == sparse-image ]]; then
      printf '%q\t%s\n' "$name" "$(stat -c '%d:%i:%f:%s:%b' -- "$path")"
    elif [[ -f "$path" ]]; then
      printf '%q\t%s\t%s\n' "$name" \
        "$(stat -c '%d:%i:%f:%s:%b' -- "$path")" \
        "$(sha256sum "$path" | cut -d' ' -f1)"
    else
      printf '%q\t%s\n' "$name" "$(stat -c '%d:%i:%f:%s:%b' -- "$path")"
    fi
  done
}

before="$work/before.inventory"
after="$work/after.inventory"
inventory > "$before"
sparse_identity="$(stat -c '%d:%i:%b' -- "$workspace/sparse-image")"
hidden="$(ghost_ci_isolation_path "$workspace")"

# Never adopt or overwrite a preexisting reserved state directory.
mkdir -- "$hidden"
if ghost_ci_hide_checkout "$workspace"; then
  printf 'checkout isolation accepted preexisting hidden state\n' >&2
  exit 1
fi
rmdir -- "$hidden"

# A mid-hide failure leaves an exact, recoverable split state.
export GHOST_CI_ISOLATION_FAIL_HIDE_AFTER=2
if ghost_ci_hide_checkout "$workspace"; then
  printf 'checkout hide failure injection did not fire\n' >&2
  exit 1
fi
unset GHOST_CI_ISOLATION_FAIL_HIDE_AFTER
[[ "${GHOST_CI_ISOLATION_CREATED:-0}" == 1 ]]
ghost_ci_restore_checkout "$workspace"
inventory > "$after"
cmp "$before" "$after"

# The successful relocation is inode-preserving, so the 8 GiB sparse fixture
# cannot have been copied. Old absolute checkout targets disappear while hidden.
ghost_ci_hide_checkout "$workspace"
payload="$hidden/payload"
[[ "$(stat -c '%d:%i:%b' -- "$payload/sparse-image")" == \
  "$sparse_identity" ]]
[[ -L "$payload/runtime-link" && ! -e "$payload/runtime-link" ]]
[[ ! -e "$workspace/source-target" ]]
[[ -e "$payload/$newline_name" ]]

# A colliding destination is detected without clobber and remains retryable.
printf 'collision\n' > "$workspace/.dotfile"
if ghost_ci_restore_checkout "$workspace"; then
  printf 'checkout restore clobbered a colliding destination\n' >&2
  exit 1
fi
[[ "$(cat "$workspace/.dotfile")" == collision ]]
rm -- "$workspace/.dotfile"

# A mid-restore failure is likewise recoverable and does not replay moves.
export GHOST_CI_ISOLATION_FAIL_RESTORE_AFTER=2
if ghost_ci_restore_checkout "$workspace"; then
  printf 'checkout restore failure injection did not fire\n' >&2
  exit 1
fi
unset GHOST_CI_ISOLATION_FAIL_RESTORE_AFTER
ghost_ci_restore_checkout "$workspace"
inventory > "$after"
cmp "$before" "$after"
[[ ! -e "$hidden" && ! -L "$hidden" ]]

# Model the verifier's signal traps: TERM must restore a fully hidden tree and
# preserve the conventional signal exit code.
ready="$work/signal-ready"
/usr/bin/bash -c '
  set -euo pipefail
  source "$1"
  workspace="$2"
  ready="$3"
  isolated=0
  cleanup_signal_test() {
    status=$?
    trap - EXIT HUP INT TERM
    if (( isolated )) || [[ "${GHOST_CI_ISOLATION_CREATED:-0}" == 1 ]]; then
      ghost_ci_restore_checkout "$workspace" || exit 1
    fi
    exit "$status"
  }
  trap cleanup_signal_test EXIT
  trap "exit 129" HUP
  trap "exit 130" INT
  trap "exit 143" TERM
  ghost_ci_hide_checkout "$workspace"
  isolated=1
  : > "$ready"
  while :; do /usr/bin/sleep 1; done
' _ "$script_dir/ci-checkout-isolation.sh" "$workspace" "$ready" &
signal_pid=$!
for _ in {1..100}; do
  [[ -e "$ready" ]] && break
  sleep 0.01
done
[[ -e "$ready" ]]
kill -TERM "$signal_pid"
set +e
wait "$signal_pid"
signal_status=$?
set -e
[[ "$signal_status" -eq 143 ]]
inventory > "$after"
cmp "$before" "$after"
[[ ! -e "$hidden" && ! -L "$hidden" ]]

# A clean retry after every injected path still succeeds.
ghost_ci_hide_checkout "$workspace"
ghost_ci_restore_checkout "$workspace"
inventory > "$after"
cmp "$before" "$after"
printf 'same-filesystem checkout isolation passed\n'
