#!/usr/bin/env bash

# Run one package check with a private XDG runtime directory. CI package
# builders do not have a logind session, while the desktop harness deliberately
# refuses to create its single-writer lock without XDG_RUNTIME_DIR.

set -euo pipefail
export LC_ALL=C

runtime_parent="${1:?usage: run-with-check-runtime.sh <runtime-parent> <command> [args...]}"
shift
(( $# > 0 )) || {
  printf 'package-check runtime wrapper requires a command\n' >&2
  exit 2
}
(( EUID != 0 )) || {
  printf 'package-check runtime wrapper must run as the unprivileged builder\n' >&2
  exit 1
}

runtime_dir=
child_pid=
child_ready=0
pending_signal=0
pending_signal_name=
terminating=0

cleanup() {
  if [[ -n "$runtime_dir" ]]; then
    if [[ -e "$runtime_dir" || -L "$runtime_dir" ]]; then
      find -P "$runtime_dir" -depth -delete
    fi
  fi
}
trap cleanup EXIT

terminate_child() {
  local signal_number="$1"
  local signal_name="$2"

  (( terminating == 0 )) || return 0
  terminating=1
  trap '' HUP INT TERM

  if [[ -n "$child_pid" ]]; then
    # The child stops itself only after setsid has made its PID the process
    # group ID, so this negative PID can never address the package builder's
    # own process group or another package check.
    if (( child_ready == 1 )); then
      kill -s "$signal_name" -- "-$child_pid" 2>/dev/null || true
      kill -CONT -- "-$child_pid" 2>/dev/null || true
    else
      kill -s "$signal_name" -- "$child_pid" 2>/dev/null || true
    fi

    # Give the owned group a short window to run its normal signal cleanup,
    # then make teardown bounded. The wrapper still reports the original
    # conventional 128+signal status if escalation was required.
    for _ in {1..200}; do
      if ! kill -0 -- "$child_pid" 2>/dev/null \
          && ! kill -0 -- "-$child_pid" 2>/dev/null; then
        break
      fi
      sleep 0.01
    done
    kill -KILL -- "-$child_pid" 2>/dev/null || true
    kill -KILL -- "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
  fi
  exit "$((128 + signal_number))"
}

record_signal() {
  pending_signal="$1"
  pending_signal_name="$2"
  if (( child_ready == 1 )); then
    terminate_child "$pending_signal" "$pending_signal_name"
  fi
}

honor_pending_signal() {
  if (( pending_signal != 0 )); then
    terminate_child "$pending_signal" "$pending_signal_name"
  fi
}

trap 'record_signal 1 HUP' HUP
trap 'record_signal 2 INT' INT
trap 'record_signal 15 TERM' TERM

[[ "$runtime_parent" == /* && -d "$runtime_parent" && ! -L "$runtime_parent" ]] || {
  printf 'package-check runtime parent is not a real absolute directory: %s\n' \
    "$runtime_parent" >&2
  exit 1
}

runtime_parent="$(realpath -e -- "$runtime_parent")"
read -r parent_uid _parent_gid parent_mode parent_type \
  < <(stat -c '%u %g %a %F' -- "$runtime_parent")
[[ "$parent_type" == directory && "$parent_uid" == "$EUID" ]] || {
  printf 'package-check runtime parent is not owned by the builder: %s\n' \
    "$runtime_parent" >&2
  exit 1
}
if (( (8#$parent_mode & 8#022) != 0 )); then
  printf 'package-check runtime parent is writable by another user: %s\n' \
    "$runtime_parent" >&2
  exit 1
fi
honor_pending_signal

umask 077
runtime_dir="$(mktemp -d -- "$runtime_parent/.ghost-package-check-runtime.XXXXXX")"

read -r runtime_uid _runtime_gid runtime_mode runtime_type \
  < <(stat -c '%u %g %a %F' -- "$runtime_dir")
[[ ! -L "$runtime_dir" && "$runtime_type" == directory \
  && "$runtime_uid" == "$EUID" && "$runtime_mode" == 700 ]] || {
  printf 'package-check runtime directory failed ownership/mode validation: %s\n' \
    "$runtime_dir" >&2
  exit 1
}
honor_pending_signal

if [[ -n "${GHOST_ARCH_CHECK_RUNTIME_TEST_HOOK_DIR:-}" ]]; then
  test_hook="$GHOST_ARCH_CHECK_RUNTIME_TEST_HOOK_DIR"
  [[ "$test_hook" == "$runtime_parent"/* && -d "$test_hook" \
    && ! -L "$test_hook" ]] || {
    printf 'package-check acquisition hook is outside its runtime parent\n' >&2
    exit 1
  }
  test_hook="$(realpath -e -- "$test_hook")"
  [[ "$(dirname -- "$test_hook")" == "$runtime_parent" \
    && "$(stat -c '%u:%a:%F' -- "$test_hook")" \
      == "$EUID:700:directory" ]] || {
    printf 'package-check acquisition hook failed ownership/mode validation\n' >&2
    exit 1
  }
  [[ ! -e "$test_hook/acquired" && ! -L "$test_hook/acquired" \
    && ! -e "$test_hook/continue" && ! -L "$test_hook/continue" ]] || {
    printf 'package-check acquisition hook is not empty\n' >&2
    exit 1
  }
  printf '%s\n' "$runtime_dir" > "$test_hook/acquired"
  while [[ ! -e "$test_hook/continue" ]]; do
    honor_pending_signal
    sleep 0.01 || true
  done
fi
honor_pending_signal

# Stop the owned child between setsid and exec. This gives the wrapper a
# deterministic point at which child_pid is assigned and its group identity is
# proven before modelled package-check code or descendants can start.
XDG_RUNTIME_DIR="$runtime_dir" \
  setsid -- bash -c 'kill -STOP "$BASHPID"; exec "$@"' bash "$@" &
child_pid=$!

for _ in {1..500}; do
  if [[ ! -r "/proc/$child_pid/stat" ]]; then
    set +e
    wait "$child_pid"
    child_status=$?
    set -e
    child_pid=
    if (( pending_signal != 0 )); then
      exit "$((128 + pending_signal))"
    fi
    exit "$child_status"
  fi
  read -r child_state child_group \
    < <(awk '{ print $3, $5 }' "/proc/$child_pid/stat")
  if [[ "$child_state" == T && "$child_group" == "$child_pid" ]]; then
    child_ready=1
    break
  fi
  sleep 0.01 || true
done

if (( child_ready == 0 )); then
  printf 'package-check child did not establish its owned process group\n' >&2
  terminate_child 15 TERM
fi
if (( pending_signal != 0 )); then
  terminate_child "$pending_signal" "$pending_signal_name"
fi

kill -CONT -- "-$child_pid"
if (( pending_signal != 0 )); then
  terminate_child "$pending_signal" "$pending_signal_name"
fi

set +e
wait "$child_pid"
child_status=$?
set -e
child_pid=
exit "$child_status"
