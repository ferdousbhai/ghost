#!/usr/bin/env bash
set -Eeuo pipefail

usage() {
  echo "usage: $0 <quickshell-config-path> [mock-ghostd-port]" >&2
  echo "       GHOSTD_PORT=<mock-ghostd-port> $0 <quickshell-config-path>" >&2
}

if (( $# < 1 || $# > 2 )); then
  usage
  exit 2
fi

config_path=$(realpath -e -- "$1")
mock_port=${2:-${GHOSTD_PORT:-}}
if [[ -z $mock_port || ! $mock_port =~ ^[0-9]+$ || $mock_port -lt 1 || $mock_port -gt 65535 ]]; then
  echo "preview: supply the already-running mock ghostd port (1-65535)" >&2
  exit 2
fi
if [[ $mock_port == 7717 ]]; then
  echo "preview: refusing port 7717; that port belongs to the owner's real ghostd" >&2
  exit 2
fi

for command_name in Hyprland hyprctl quickshell qs grim curl node dbus-daemon setsid; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "preview: missing required command: $command_name" >&2
    exit 1
  fi
done

owner_home=${HOME:?preview: HOME is required}
owner_ghosts_root=${GHOSTS_ROOT:-$owner_home/ghosts}
parent_runtime=${XDG_RUNTIME_DIR:?preview: XDG_RUNTIME_DIR is required}
parent_display=${WAYLAND_DISPLAY:?preview: run this from the owner Wayland desktop}
if [[ $parent_display == /* ]]; then
  parent_socket=$parent_display
else
  parent_socket=$parent_runtime/$parent_display
fi
if [[ ! -S $parent_socket ]]; then
  echo "preview: parent Wayland socket is not available: $parent_socket" >&2
  exit 1
fi

# Accept only a mock roster whose homes are outside the owner's ghost root.
# The shell then gets an isolated HOME and XDG tree as a second guard.
if ! roster_json=$(curl --fail --silent --show-error --max-time 3 \
    "http://127.0.0.1:${mock_port}/api/ghosts"); then
  echo "preview: mock ghostd is not answering on 127.0.0.1:${mock_port}" >&2
  exit 1
fi
if ! printf '%s' "$roster_json" | node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const canonical = value => {
    try { return fs.realpathSync.native(value); } catch { return path.resolve(value); }
  };
  const forbidden = canonical(process.argv[1]);
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    let rows;
    try { rows = JSON.parse(input); } catch { process.exit(2); }
    if (!Array.isArray(rows)) process.exit(2);
    for (const row of rows) {
      const dir = row && typeof row.dir === "string" ? canonical(row.dir) : "";
      if (dir === forbidden || dir.startsWith(forbidden + path.sep)) process.exit(3);
    }
  });
' "$owner_ghosts_root"; then
  echo "preview: refusing a daemon roster that could expose the owner's real ghost home" >&2
  exit 1
fi

preview_root=""
runtime_root=""
cleanup_roots() {
  local status=$?
  trap - EXIT
  if [[ -n $preview_root && $preview_root == "/tmp/ghost-shell-preview."* ]]; then
    rm -rf -- "$preview_root"
  fi
  if [[ -n $runtime_root && $runtime_root == "/tmp/ghp."* ]]; then
    rm -rf -- "$runtime_root"
  fi
  exit "$status"
}
trap cleanup_roots EXIT

# Wayland and Hyprland IPC use AF_UNIX paths capped at 108 bytes. Keep this
# runtime root short even when the caller has a deeply nested TMPDIR.
preview_root=$(mktemp -d "/tmp/ghost-shell-preview.XXXXXX")
runtime_root=$(mktemp -d "/tmp/ghp.XXXXXX")
chmod 700 "$preview_root"
chmod 700 "$runtime_root"
mkdir -p "$preview_root"/{home,config,state,data,cache,ghosts}

hypr_pid=""
quickshell_pid=""
dbus_pid=""
cleanup_started=0

stop_process_group() {
  local pid=$1
  local signal=$2
  [[ -n $pid ]] || return 0
  kill -0 "$pid" 2>/dev/null || return 0
  local pgid
  pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
  if [[ $pgid == "$pid" ]]; then
    kill "-$signal" -- "-$pid" 2>/dev/null || true
  else
    kill "-$signal" "$pid" 2>/dev/null || true
  fi
}

cleanup() {
  local status=$?
  (( cleanup_started == 0 )) || return
  cleanup_started=1
  trap - EXIT INT TERM

  stop_process_group "$quickshell_pid" TERM
  stop_process_group "$hypr_pid" TERM
  [[ -z $dbus_pid ]] || kill -TERM "$dbus_pid" 2>/dev/null || true

  for _ in {1..30}; do
    local alive=0
    [[ -z $quickshell_pid ]] || ! kill -0 "$quickshell_pid" 2>/dev/null || alive=1
    [[ -z $hypr_pid ]] || ! kill -0 "$hypr_pid" 2>/dev/null || alive=1
    [[ -z $dbus_pid ]] || ! kill -0 "$dbus_pid" 2>/dev/null || alive=1
    (( alive == 0 )) && break
    sleep 0.1
  done

  stop_process_group "$quickshell_pid" KILL
  stop_process_group "$hypr_pid" KILL
  [[ -z $dbus_pid ]] || kill -KILL "$dbus_pid" 2>/dev/null || true
  [[ -z $quickshell_pid ]] || wait "$quickshell_pid" 2>/dev/null || true
  [[ -z $hypr_pid ]] || wait "$hypr_pid" 2>/dev/null || true
  [[ -z $dbus_pid ]] || wait "$dbus_pid" 2>/dev/null || true

  if [[ -n $preview_root && $preview_root == "/tmp/ghost-shell-preview."* ]]; then
    rm -rf -- "$preview_root"
  fi
  if [[ -n $runtime_root && $runtime_root == "/tmp/ghp."* ]]; then
    rm -rf -- "$runtime_root"
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# A session bus with no service directories: nothing can be dbus-activated
# on it. With the stock session config, Quickshell's portal registration
# activated an xdg-desktop-portal-hyprland on this private bus, which then
# crashed on exit when the nested compositor went away (ghost#66) — a
# coredump the host reports as if its own portal had failed.
dbus_config=$preview_root/dbus.conf
cat >"$dbus_config" <<EOF_DBUS
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:abstract=ghost-shell-preview-$BASHPID</listen>
  <keep_umask/>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF_DBUS
mapfile -t dbus_details < <(dbus-daemon --config-file="$dbus_config" --fork \
  --print-address=1 --print-pid=1)
if (( ${#dbus_details[@]} != 2 )); then
  echo "preview: could not start the isolated session bus" >&2
  exit 1
fi
dbus_address=${dbus_details[0]}
dbus_pid=${dbus_details[1]}

hypr_config=$preview_root/hyprland.lua
printf '%s\n' \
  'hl.monitor({ output = "", mode = "1280x720@60", position = "0x0", scale = 1 })' \
  'hl.config({' \
  '  general = { gaps_in = 0, gaps_out = 0, border_size = 0 },' \
  '  decoration = { rounding = 0, shadow = { enabled = false }, blur = { enabled = false } },' \
  '  animations = { enabled = false },' \
  '  misc = { disable_hyprland_logo = true, disable_splash_rendering = true },' \
  '})' > "$hypr_config"

export HOME=$preview_root/home
export XDG_CONFIG_HOME=$preview_root/config
export XDG_STATE_HOME=$preview_root/state
export XDG_DATA_HOME=$preview_root/data
export XDG_CACHE_HOME=$preview_root/cache
export XDG_RUNTIME_DIR=$runtime_root
export DBUS_SESSION_BUS_ADDRESS=$dbus_address
export GHOSTD_PORT=$mock_port
export GHOSTS_ROOT=$preview_root/ghosts
export QT_QPA_PLATFORM=wayland
unset HYPRLAND_INSTANCE_SIGNATURE

setsid env WAYLAND_DISPLAY="$parent_socket" Hyprland --config "$hypr_config" \
  >"$preview_root/hyprland.log" 2>&1 &
hypr_pid=$!

nested_signature=""
nested_display=""
for _ in {1..120}; do
  if ! kill -0 "$hypr_pid" 2>/dev/null; then
    echo "preview: nested Hyprland exited during startup" >&2
    sed -n '1,160p' "$preview_root/hyprland.log" >&2
    exit 1
  fi
  for instance_dir in "$XDG_RUNTIME_DIR"/hypr/*; do
    [[ -S $instance_dir/.socket.sock && -f $instance_dir/hyprland.lock ]] || continue
    candidate_display=$(sed -n '2p' "$instance_dir/hyprland.lock")
    [[ -n $candidate_display && -S $XDG_RUNTIME_DIR/$candidate_display ]] || continue
    nested_signature=$(basename "$instance_dir")
    nested_display=$candidate_display
    break 2
  done
  sleep 0.1
done
if [[ -z $nested_signature || -z $nested_display ]]; then
  echo "preview: nested Hyprland did not publish its isolated sockets" >&2
  sed -n '1,160p' "$preview_root/hyprland.log" >&2
  exit 1
fi

export HYPRLAND_INSTANCE_SIGNATURE=$nested_signature
export WAYLAND_DISPLAY=$nested_display
config_errors=$(hyprctl --instance "$nested_signature" configerrors)
if [[ -n $config_errors ]]; then
  echo "preview: nested Hyprland rejected its configuration" >&2
  printf '%s\n' "$config_errors" >&2
  exit 1
fi

setsid quickshell -p "$config_path" >"$preview_root/quickshell.log" 2>&1 &
quickshell_pid=$!

shell_ready=0
for _ in {1..120}; do
  if ! kill -0 "$quickshell_pid" 2>/dev/null; then
    echo "preview: Quickshell exited during startup" >&2
    sed -n '1,200p' "$preview_root/quickshell.log" >&2
    exit 1
  fi
  if qs -p "$config_path" ipc call ghost status >/dev/null 2>&1; then
    shell_ready=1
    break
  fi
  sleep 0.1
done
if (( shell_ready == 0 )); then
  echo "preview: the ghost IPC surface did not become ready" >&2
  sed -n '1,200p' "$preview_root/quickshell.log" >&2
  exit 1
fi

qs -p "$config_path" ipc call ghost open >/dev/null
sleep "${GHOST_PREVIEW_SETTLE_SECONDS:-1}"

echo "preview: nested HUD is ready"
echo "  XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
echo "  WAYLAND_DISPLAY=$WAYLAND_DISPLAY"
echo "  HYPRLAND_INSTANCE_SIGNATURE=$HYPRLAND_INSTANCE_SIGNATURE"
echo "  Hyprland pid=$hypr_pid; Quickshell pid=$quickshell_pid; mock port=$mock_port"

if [[ -n ${GHOST_PREVIEW_SCREENSHOT:-} ]]; then
  grim "$GHOST_PREVIEW_SCREENSHOT"
  if [[ ! -s $GHOST_PREVIEW_SCREENSHOT ]]; then
    echo "preview: grim did not produce a screenshot" >&2
    exit 1
  fi
  echo "preview: screenshot captured with nested grim: $GHOST_PREVIEW_SCREENSHOT"
fi

set +e
wait -n "$hypr_pid" "$quickshell_pid"
preview_status=$?
set -e
exit "$preview_status"
