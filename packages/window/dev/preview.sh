#!/usr/bin/env bash
set -Eeuo pipefail

# Ghost's window in a nested Hyprland, against a scratch ghostd from this
# checkout and a scratch owner home seeded with sample data: private HOME,
# XDG directories, and D-Bus, never the owner's ghosts, data, or port 7717
# (stand-in.sh). Stand-in product CLIs come first on ghostd's PATH, so no real
# account is read.
#
#   preview.sh <screenshot.png> [route]
#
# `route` is GHOST_WINDOW_OPEN: `connect`, a source id (`notes`), `<source id>/<item id>`, or `ask:<prompt>`.
if (( $# < 1 || $# > 2 )); then
  echo "usage: $0 <screenshot.png> [route]" >&2
  exit 2
fi
screenshot=$(realpath -m -- "$1")
route=${2:-}

here=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(realpath -e -- "$here/../../..")
# shellcheck source=stand-in.sh
source "$here/stand-in.sh"
binary=${GHOST_WINDOW_BINARY:-$repo/packages/window/target/release/ghost-window}
[[ -x $binary ]] || { echo "preview: build the window first (cargo build --release in packages/window)" >&2; exit 1; }
for command_name in Hyprland hyprctl grim jq bun dbus-daemon setsid curl; do
  command -v "$command_name" >/dev/null || { echo "preview: $command_name is required" >&2; exit 1; }
done
parent_runtime=${XDG_RUNTIME_DIR:?preview: XDG_RUNTIME_DIR is required}
parent_display=${WAYLAND_DISPLAY:?preview: run this from the owner Wayland desktop}
parent_socket=$parent_runtime/$parent_display
theme_colors=$HOME/.local/state/omarchy/current/theme/colors.toml

root=""
runtime=""
hypr_pid=""
daemon_pid=""
window_pid=""
dbus_pid=""
cleanup() {
  local status=$?
  trap - EXIT INT TERM
  local pid
  # Only the PIDs this script started.
  for pid in "$window_pid" "$daemon_pid" "$hypr_pid" "$dbus_pid"; do
    [[ -z $pid ]] || kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in {1..30}; do
    local alive=0
    for pid in "$window_pid" "$daemon_pid" "$hypr_pid" "$dbus_pid"; do
      [[ -z $pid ]] || ! kill -0 "$pid" 2>/dev/null || alive=1
    done
    (( alive == 0 )) && break
    sleep 0.1
  done
  for pid in "$window_pid" "$daemon_pid" "$hypr_pid" "$dbus_pid"; do
    [[ -z $pid ]] || kill -KILL "$pid" 2>/dev/null || true
  done
  [[ -z $root || $root != /tmp/ghost-window-preview.* ]] || rm -rf -- "$root"
  [[ -z $runtime || $runtime != /tmp/ghw.* ]] || rm -rf -- "$runtime"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Wayland and Hyprland IPC use AF_UNIX paths capped at 108 bytes.
root=$(mktemp -d /tmp/ghost-window-preview.XXXXXX)
runtime=$(mktemp -d /tmp/ghw.XXXXXX)
chmod 700 "$root" "$runtime"
export XDG_RUNTIME_DIR=$runtime
stand_in_home

# The owner's theme colours, copied, so the window is checked in the look it will have.
if [[ -f $theme_colors ]]; then
  mkdir -p "$HOME/.local/state/omarchy/current/theme"
  cp "$theme_colors" "$HOME/.local/state/omarchy/current/theme/colors.toml"
  echo preview > "$HOME/.local/state/omarchy/current/theme.name"
fi

stand_in_ghostd

# A session bus with no service directories: nothing can be dbus-activated on it.
cat > "$root/dbus.conf" <<EOF_DBUS
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:abstract=ghost-window-preview-$BASHPID</listen>
  <keep_umask/>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF_DBUS
mapfile -t dbus_details < <(/usr/bin/dbus-daemon --config-file="$root/dbus.conf" --fork --print-address=1 --print-pid=1)
(( ${#dbus_details[@]} == 2 )) || { echo "preview: could not start the isolated session bus" >&2; exit 1; }
export DBUS_SESSION_BUS_ADDRESS=${dbus_details[0]}
dbus_pid=${dbus_details[1]}

printf '%s\n' \
  'hl.monitor({ output = "", mode = "1280x820@60", position = "auto", scale = 1 })' \
  'hl.config({' \
  '  general = { gaps_in = 0, gaps_out = 0, border_size = 0 },' \
  '  decoration = { rounding = 0, shadow = { enabled = false }, blur = { enabled = false } },' \
  '  animations = { enabled = false },' \
  '  misc = { disable_hyprland_logo = true, disable_splash_rendering = true },' \
  '})' \
  'hl.window_rule({ match = { class = ".*" }, monitor = "ghost" })' > "$root/hyprland.lua"
unset HYPRLAND_INSTANCE_SIGNATURE
/usr/bin/setsid /usr/bin/env WAYLAND_DISPLAY="$parent_socket" /usr/bin/Hyprland --config "$root/hyprland.lua" > "$root/hyprland.log" 2>&1 &
hypr_pid=$!
signature=""
display=""
for _ in {1..120}; do
  kill -0 "$hypr_pid" 2>/dev/null || { echo "preview: nested Hyprland exited during startup" >&2; sed -n '1,80p' "$root/hyprland.log" >&2; exit 1; }
  for instance in "$XDG_RUNTIME_DIR"/hypr/*; do
    [[ -S $instance/.socket.sock && -f $instance/hyprland.lock ]] || continue
    candidate=$(sed -n '2p' "$instance/hyprland.lock")
    [[ -n $candidate && -S $XDG_RUNTIME_DIR/$candidate ]] || continue
    signature=$(basename "$instance")
    display=$candidate
    break 2
  done
  sleep 0.1
done
[[ -n $signature ]] || { echo "preview: nested Hyprland did not publish its sockets" >&2; exit 1; }
export HYPRLAND_INSTANCE_SIGNATURE=$signature WAYLAND_DISPLAY=$display

# The nested compositor's own output is a window on the desktop this runs from, which that desktop may hide or
# tile at another size, and then has no frame to capture. The window goes on a headless output instead, whose
# size is the monitor rule's; the window rule sends it there.
hyprctl output create headless ghost >/dev/null

GHOST_WINDOW_OPEN=$route GDK_BACKEND=wayland "$binary" > "$root/window.log" 2>&1 &
window_pid=$!
on_output() {
  local output
  output=$(hyprctl monitors -j | jq 'first(.[] | select(.name == "ghost") | .id)') &&
    hyprctl clients -j | jq -e --argjson output "${output:-null}" 'any(.[]; .mapped and .monitor == $output)' >/dev/null
}
# The window, then what the route loads (an asked question's answer most of all).
sleep "${GHOST_WINDOW_SETTLE:-4}"
kill -0 "$window_pid" 2>/dev/null || { echo "preview: the window exited" >&2; sed -n '1,40p' "$root/window.log" >&2; exit 1; }
# A picture of an output the window is not on would be blank, and look like a result.
on_output || { echo "preview: the window is not on the output being captured" >&2; hyprctl clients >&2; exit 1; }
mkdir -p "$(dirname "$screenshot")"
# Hyprland's own notices (it says it was started without its wrapper) would cover the header.
hyprctl dismissnotify >/dev/null
/usr/bin/grim -o ghost "$screenshot"
echo "preview: $screenshot"
[[ ! -s $root/window.log ]] || sed -n '1,20p' "$root/window.log" >&2
