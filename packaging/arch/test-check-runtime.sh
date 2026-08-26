#!/usr/bin/env bash

# Exercise the package-check XDG runtime wrapper and keep the development
# PKGBUILD's desktop-helper test invocation tied to it.

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
wrapper="$script_dir/run-with-check-runtime.sh"

if [[ "${1:-}" == --signal-child ]]; then
  ready="$2"
  runtime_record="$3"
  descendant_record="$4"
  trap 'exit 0' HUP INT TERM
  bash -c 'trap "exit 0" HUP INT TERM; while :; do sleep 1; done' &
  descendant=$!
  printf '%s\n' "$XDG_RUNTIME_DIR" > "$runtime_record"
  printf '%s\n' "$descendant" > "$descendant_record"
  printf 'ready\n' > "$ready"
  wait "$descendant"
  exit $?
fi
if [[ "${1:-}" == --stubborn-signal-child ]]; then
  ready="$2"
  runtime_record="$3"
  descendant_record="$4"
  trap '' HUP INT TERM
  bash -c 'trap "" HUP INT TERM; while :; do sleep 1; done' &
  descendant=$!
  printf '%s\n' "$XDG_RUNTIME_DIR" > "$runtime_record"
  printf '%s\n' "$descendant" > "$descendant_record"
  printf 'ready\n' > "$ready"
  wait "$descendant"
  exit $?
fi
if [[ "${1:-}" == --unrelated-sentinel ]]; then
  ready="$2"
  signal_record="$3"
  trap 'printf "signalled\n" > "$signal_record"; exit 91' HUP INT TERM
  printf 'ready\n' > "$ready"
  while :; do sleep 1; done
fi
if [[ "${1:-}" == --runtime-content-symlink-child ]]; then
  runtime_record="$2"
  outside="$3"
  printf '%s\n' "$XDG_RUNTIME_DIR" > "$runtime_record"
  ln -s "$outside" "$XDG_RUNTIME_DIR/outside-link"
  exit 0
fi
if [[ "${1:-}" == --runtime-root-symlink-child ]]; then
  runtime_record="$2"
  outside="$3"
  printf '%s\n' "$XDG_RUNTIME_DIR" > "$runtime_record"
  rmdir "$XDG_RUNTIME_DIR"
  ln -s "$outside" "$XDG_RUNTIME_DIR"
  exit 0
fi

root_refusal_only=0
if [[ "${1:-}" == --root-refusal-only ]]; then
  root_refusal_only=1
  shift
fi
pkgbuild="${1:-$script_dir/PKGBUILD}"
temp_base="${GHOST_ARCH_CHECK_RUNTIME_TEST_ROOT:-${TMPDIR:-/tmp}}"
[[ -d "$temp_base" && ! -L "$temp_base" ]] || {
  printf 'runtime-wrapper test parent is not a real directory: %s\n' "$temp_base" >&2
  exit 1
}
work="$(mktemp -d -- "$temp_base/ghost-check-runtime-test.XXXXXX")"
unrelated_pid=
cleanup() {
  if [[ -n "$unrelated_pid" ]]; then
    kill -KILL "$unrelated_pid" 2>/dev/null || true
    wait "$unrelated_pid" 2>/dev/null || true
  fi
  find -P "$work" -depth -delete
}
trap cleanup EXIT

if (( root_refusal_only == 1 )); then
  (( EUID == 0 )) || {
    printf 'root-refusal check must itself run as root\n' >&2
    exit 1
  }
  if bash "$wrapper" "$work" true >/dev/null 2>&1; then
    printf 'runtime wrapper accepted a root caller\n' >&2
    exit 1
  fi
  printf 'Arch package-check runtime root refusal passed\n'
  exit 0
fi
(( EUID != 0 )) || {
  printf 'runtime-wrapper isolation tests must run as the unprivileged builder\n' >&2
  exit 1
}

grep -Fq 'run-with-check-runtime.sh" "$srcdir" \' "$pkgbuild"
grep -Fq "uv run --frozen pytest -m 'not live'" "$pkgbuild"

parent="$work/parent"
inherited="$work/inherited"
record="$work/runtime-path"
install -d -m700 "$parent" "$inherited"
install -d -m700 "$parent/.ghost-package-check-runtime.COLLISION"
printf 'keep\n' > "$parent/.ghost-package-check-runtime.COLLISION/sentinel"

GHOST_RUNTIME_RECORD="$record" \
GHOST_INHERITED_RUNTIME="$inherited" \
XDG_RUNTIME_DIR="$inherited" \
bash "$wrapper" "$parent" bash -c '
  set -euo pipefail
  [[ "$XDG_RUNTIME_DIR" != "$GHOST_INHERITED_RUNTIME" ]]
  [[ -d "$XDG_RUNTIME_DIR" && ! -L "$XDG_RUNTIME_DIR" ]]
  [[ "$(stat -c "%u:%a:%F" -- "$XDG_RUNTIME_DIR")" \
    == "$EUID:700:directory" ]]
  printf "%s\n" "$XDG_RUNTIME_DIR" > "$GHOST_RUNTIME_RECORD"
  mkdir "$XDG_RUNTIME_DIR/nested"
  mkfifo "$XDG_RUNTIME_DIR/nested/pipe"
'
runtime_dir="$(<"$record")"
[[ ! -e "$runtime_dir" && ! -L "$runtime_dir" ]]
[[ -f "$parent/.ghost-package-check-runtime.COLLISION/sentinel" ]]
[[ -d "$inherited" ]]

failure_record="$work/failure-runtime-path"
set +e
GHOST_RUNTIME_RECORD="$failure_record" bash "$wrapper" "$parent" bash -c '
  printf "%s\n" "$XDG_RUNTIME_DIR" > "$GHOST_RUNTIME_RECORD"
  exit 23
'
failure_status=$?
set -e
[[ "$failure_status" == 23 ]]
failed_runtime_dir="$(<"$failure_record")"
[[ ! -e "$failed_runtime_dir" && ! -L "$failed_runtime_dir" ]]

outside="$work/outside"
install -d -m700 "$outside"
printf 'outside\n' > "$outside/sentinel"

acquisition_hook="$parent/acquisition-hook"
install -d -m700 "$acquisition_hook"
acquisition_child_marker="$work/acquisition-child-started"
env --default-signal=HUP --default-signal=INT --default-signal=TERM \
  GHOST_ARCH_CHECK_RUNTIME_TEST_HOOK_DIR="$acquisition_hook" \
  GHOST_ACQUISITION_CHILD_MARKER="$acquisition_child_marker" \
  bash "$wrapper" "$parent" bash -c \
    'printf "started\n" > "$GHOST_ACQUISITION_CHILD_MARKER"' &
acquisition_wrapper=$!
for _ in {1..500}; do
  [[ -f "$acquisition_hook/acquired" ]] && break
  kill -0 "$acquisition_wrapper" 2>/dev/null || break
  sleep 0.01
done
[[ -f "$acquisition_hook/acquired" ]]
acquisition_runtime="$(<"$acquisition_hook/acquired")"
kill -TERM "$acquisition_wrapper"
set +e
wait "$acquisition_wrapper"
acquisition_status=$?
set -e
[[ "$acquisition_status" == 143 ]]
[[ ! -e "$acquisition_runtime" && ! -L "$acquisition_runtime" ]]
[[ ! -e "$acquisition_child_marker" ]]
grep -Fxq outside "$outside/sentinel"

content_link_record="$work/content-link-runtime-path"
bash "$wrapper" "$parent" bash "$script_dir/test-check-runtime.sh" \
  --runtime-content-symlink-child \
  "$content_link_record" "$outside"
content_link_runtime="$(<"$content_link_record")"
[[ ! -e "$content_link_runtime" && ! -L "$content_link_runtime" ]]
grep -Fxq outside "$outside/sentinel"

root_link_record="$work/root-link-runtime-path"
bash "$wrapper" "$parent" bash "$script_dir/test-check-runtime.sh" \
  --runtime-root-symlink-child \
  "$root_link_record" "$outside"
root_link_runtime="$(<"$root_link_record")"
[[ ! -e "$root_link_runtime" && ! -L "$root_link_runtime" ]]
grep -Fxq outside "$outside/sentinel"

for signal_spec in 'HUP 129' 'INT 130' 'TERM 143'; do
  read -r signal expected_status <<< "$signal_spec"
  ready="$work/$signal.ready"
  signal_runtime_record="$work/$signal.runtime"
  descendant_record="$work/$signal.descendant"
  env --default-signal=HUP --default-signal=INT --default-signal=TERM \
    bash "$wrapper" "$parent" bash "$script_dir/test-check-runtime.sh" \
      --signal-child \
      "$ready" "$signal_runtime_record" "$descendant_record" &
  wrapper_pid=$!
  for _ in {1..500}; do
    [[ -f "$ready" ]] && break
    kill -0 "$wrapper_pid" 2>/dev/null || break
    sleep 0.01
  done
  [[ -f "$ready" ]]
  signal_runtime="$(<"$signal_runtime_record")"
  descendant="$(<"$descendant_record")"
  kill -s "$signal" "$wrapper_pid"
  set +e
  wait "$wrapper_pid"
  wrapper_status=$?
  set -e
  [[ "$wrapper_status" == "$expected_status" ]]
  [[ ! -e "$signal_runtime" && ! -L "$signal_runtime" ]]
  for _ in {1..200}; do
    kill -0 "$descendant" 2>/dev/null || break
    sleep 0.01
  done
  if kill -0 "$descendant" 2>/dev/null; then
    printf 'runtime wrapper left a descendant after %s\n' "$signal" >&2
    exit 1
  fi
  grep -Fxq outside "$outside/sentinel"
done

unrelated_ready="$work/unrelated.ready"
unrelated_signal="$work/unrelated.signal"
env --default-signal=HUP --default-signal=INT --default-signal=TERM \
  bash "$script_dir/test-check-runtime.sh" --unrelated-sentinel \
    "$unrelated_ready" "$unrelated_signal" &
unrelated_pid=$!
for _ in {1..500}; do
  [[ -f "$unrelated_ready" ]] && break
  kill -0 "$unrelated_pid" 2>/dev/null || break
  sleep 0.01
done
[[ -f "$unrelated_ready" ]]

stubborn_ready="$work/stubborn.ready"
stubborn_runtime_record="$work/stubborn.runtime"
stubborn_descendant_record="$work/stubborn.descendant"
env --default-signal=HUP --default-signal=INT --default-signal=TERM \
  bash "$wrapper" "$parent" bash "$script_dir/test-check-runtime.sh" \
    --stubborn-signal-child "$stubborn_ready" "$stubborn_runtime_record" \
      "$stubborn_descendant_record" &
stubborn_wrapper=$!
for _ in {1..500}; do
  [[ -f "$stubborn_ready" ]] && break
  kill -0 "$stubborn_wrapper" 2>/dev/null || break
  sleep 0.01
done
[[ -f "$stubborn_ready" ]]
stubborn_runtime="$(<"$stubborn_runtime_record")"
stubborn_descendant="$(<"$stubborn_descendant_record")"
stubborn_started="$(date +%s%3N)"
kill -TERM "$stubborn_wrapper"
set +e
wait "$stubborn_wrapper"
stubborn_status=$?
set -e
stubborn_elapsed=$(( $(date +%s%3N) - stubborn_started ))
[[ "$stubborn_status" == 143 ]]
(( stubborn_elapsed >= 1500 && stubborn_elapsed < 5000 ))
[[ ! -e "$stubborn_runtime" && ! -L "$stubborn_runtime" ]]
if kill -0 "$stubborn_descendant" 2>/dev/null; then
  printf 'runtime wrapper left its stubborn descendant alive\n' >&2
  exit 1
fi
kill -0 "$unrelated_pid"
[[ ! -e "$unrelated_signal" ]]
grep -Fxq outside "$outside/sentinel"

for delay_ms in 0 1 3; do
  for sample in {1..20}; do
    race_ready="$work/race-$delay_ms-$sample.ready"
    race_runtime="$work/race-$delay_ms-$sample.runtime"
    race_descendant="$work/race-$delay_ms-$sample.descendant"
    env --default-signal=HUP --default-signal=INT --default-signal=TERM \
      bash "$wrapper" "$parent" bash "$script_dir/test-check-runtime.sh" \
        --signal-child "$race_ready" "$race_runtime" "$race_descendant" &
    race_wrapper=$!
    if (( delay_ms > 0 )); then
      sleep "0.00$delay_ms"
    fi
    kill -TERM "$race_wrapper"
    set +e
    wait "$race_wrapper"
    race_status=$?
    set -e
    [[ "$race_status" == 143 ]]
    if [[ -f "$race_runtime" ]]; then
      used_runtime="$(<"$race_runtime")"
      [[ ! -e "$used_runtime" && ! -L "$used_runtime" ]]
    fi
  done
done
if find "$parent" -mindepth 1 -maxdepth 1 \
    -name '.ghost-package-check-runtime.*' \
    ! -name '.ghost-package-check-runtime.COLLISION' -print -quit | grep -q .; then
  printf 'runtime wrapper race stress left a reserved directory\n' >&2
  exit 1
fi
kill -0 "$unrelated_pid"
[[ ! -e "$unrelated_signal" ]]
grep -Fxq outside "$outside/sentinel"

assert_rejected_parent() {
  local candidate="$1"
  if bash "$wrapper" "$candidate" true >/dev/null 2>&1; then
    printf 'runtime wrapper accepted unsafe parent: %s\n' "$candidate" >&2
    exit 1
  fi
}

ln -s "$parent" "$work/parent-link"
printf 'file\n' > "$work/parent-file"
mkfifo "$work/parent-fifo"
install -d -m777 "$work/world-writable"
assert_rejected_parent "$work/parent-link"
assert_rejected_parent "$work/parent-file"
assert_rejected_parent "$work/parent-fifo"
assert_rejected_parent "$work/world-writable"

printf 'Arch package-check runtime isolation passed\n'
