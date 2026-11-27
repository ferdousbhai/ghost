#!/usr/bin/env bash
set -Eeuo pipefail

# The bar's QA scripts (dev/qa/*.jsonl, omui's scripted QA: README "Scripted QA" in omui), each in a fresh bar
# built with feature `qa`, against one scratch ghostd and a stand-in model (stand-in.sh), on a broadway display of its own:
# private HOME, XDG directories and runtime, no session bus, no Wayland or X display, so no window opens anywhere and
# nothing of the desktop this is run from is read. Any failed command, GLib warning or critical fails the run.
# The gate (`.githooks/verify`) runs it.
#
#   dev/qa.sh [script.jsonl ...]           every script under dev/qa when none is named
#   GHOST_BAR_QA=0                      skip it (the package build's check(), which builds no `qa` bar)
#   GHOST_BAR_QA_BINARY=<path>          a bar already built with `--features qa`
#   GHOST_BAR_QA_SHOTS=<dir>            keep the scripts' shots there (they are written relative to it)
#   OMUI_QA_TIMEOUT=120                    seconds before one script's run is stopped
if [[ ${GHOST_BAR_QA:-1} == 0 ]]; then
  echo "qa: skipped (GHOST_BAR_QA=0)"
  exit 0
fi
here=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
# shellcheck source=stand-in.sh
source "$here/stand-in.sh"
for command_name in gtk4-broadwayd curl; do
  command -v "$command_name" >/dev/null || { echo "qa: $command_name is required" >&2; exit 1; }
done
if (( $# )); then
  scripts=("$@")
else
  scripts=("$here"/qa/*.jsonl)
fi
for index in "${!scripts[@]}"; do scripts[index]=$(realpath -e -- "${scripts[index]}"); done

binary=${GHOST_BAR_QA_BINARY:-}
if [[ -z $binary ]]; then
  # A debug build: target/release stays the bar the package ships, without `qa`.
  (cd "$here/.." && bash dev/cargo.sh build --locked --features qa --quiet)
  binary=$here/../../../target/debug/ghost-bar
fi
binary=$(realpath -e -- "$binary")

root=$(mktemp -d /tmp/ghost-bar-qa.XXXXXX)
broadway_pid=""
daemon_pid=""
app_pid=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local pid
  # Only the PIDs this script started.
  for pid in "$app_pid" "$broadway_pid" "$daemon_pid"; do
    [[ -z $pid ]] || kill -TERM "$pid" 2>/dev/null || true
  done
  for pid in "$app_pid" "$broadway_pid" "$daemon_pid"; do
    [[ -z $pid ]] || wait "$pid" 2>/dev/null || true
  done
  [[ -z $root || $root != /tmp/ghost-bar-qa.* ]] || rm -rf -- "$root"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 700 "$root"
mkdir -p "$root/runtime" "$root/shots"
chmod 700 "$root/runtime"
export XDG_RUNTIME_DIR=$root/runtime
stand_in_home
stand_in_ghostd
shots=${GHOST_BAR_QA_SHOTS:-$root/shots}
mkdir -p "$shots"

# A display number and input port from this script's PID, so two runs at once do not share one. broadwayd listens on
# 127.0.0.1 alone, where the app sends key presses (`key`, `type`) as broadway's web page would.
display=$(( 100 + $$ % 800 ))
input_port=$(( 8080 + display ))
gtk4-broadwayd --address 127.0.0.1 --port "$input_port" ":$display" > "$root/broadwayd.log" 2>&1 &
broadway_pid=$!
for _ in {1..50}; do
  [[ -S $XDG_RUNTIME_DIR/broadway$((display + 1)).socket ]] && break
  kill -0 "$broadway_pid" 2>/dev/null || { cat "$root/broadwayd.log" >&2; exit 1; }
  sleep 0.1
done

failed=0
for script in "${scripts[@]}"; do
  echo "qa: ${script#"$here/"}"
  # In the background, waited for: bash runs a trap only once the foreground command ends, and `timeout` puts the app
  # in a process group of its own, which Ctrl-C does not reach. Killing `timeout` stops the app with it. TZ fixes the
  # times it shows, which the scripts name widgets by.
  status=0
  (cd "$shots" && exec env -u WAYLAND_DISPLAY -u DISPLAY -u GTK_THEME \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent TZ=UTC \
    GDK_BACKEND=broadway BROADWAY_DISPLAY=":$display" OMUI_QA=1 OMUI_QA_INPUT="127.0.0.1:$input_port" OMUI_QA_FD=3 \
    timeout "${OMUI_QA_TIMEOUT:-120}" "$binary" < "$script" 3> "$root/answers") &
  app_pid=$!
  wait "$app_pid" || status=$?
  app_pid=""
  # Each command beside its answer; `quit`'s answer, or the failure that ended the run, comes last.
  grep -Ev '^[[:space:]]*(#|$)' "$script" | awk -v answers="$root/answers" '
    { if ((getline answer < answers) > 0) { print "> " $0; print "< " answer } else { print "> " $0 " (not run)" } }
    END { while ((getline answer < answers) > 0) print "< " answer }'
  if (( status == 0 )); then
    echo "qa: passed"
  else
    echo "qa: failed with status $status"
    failed=1
  fi
done
(( failed == 0 )) || sed -n '1,40p' "$root/ghostd.log" >&2
exit "$failed"
