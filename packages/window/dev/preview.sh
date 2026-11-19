#!/usr/bin/env bash
set -Eeuo pipefail

# Ghost's window in a nested Hyprland, against a scratch ghostd from this
# checkout and a scratch owner home seeded with sample data: private HOME,
# XDG directories, and D-Bus, never the owner's ghosts, data, or port 7717.
# Stand-in product CLIs come first on PATH, so no real account is read.
#
#   preview.sh <screenshot.png> [route]
#
# `route` is GHOST_WINDOW_OPEN: a source id (`notes`), or `ask:<prompt>`.
if (( $# < 1 || $# > 2 )); then
  echo "usage: $0 <screenshot.png> [route]" >&2
  exit 2
fi
screenshot=$(realpath -m -- "$1")
route=${2:-}

here=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
repo=$(realpath -e -- "$here/../../..")
binary=${GHOST_WINDOW_BINARY:-$repo/packages/window/target/release/ghost-window}
[[ -x $binary ]] || { echo "preview: build the window first (cargo build --release in packages/window)" >&2; exit 1; }
for command_name in Hyprland hyprctl grim bun dbus-daemon setsid curl; do
  command -v "$command_name" >/dev/null || { echo "preview: $command_name is required" >&2; exit 1; }
done
parent_runtime=${XDG_RUNTIME_DIR:?preview: XDG_RUNTIME_DIR is required}
parent_display=${WAYLAND_DISPLAY:?preview: run this from the owner Wayland desktop}
parent_socket=$parent_runtime/$parent_display
theme_colors=$HOME/.local/state/omarchy/current/theme/colors.toml
bun_bin=$(command -v bun)

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
mkdir -p "$root"/{home,config,state,data,cache,ghosts,bin}

export HOME=$root/home
export XDG_CONFIG_HOME=$root/config XDG_STATE_HOME=$root/state XDG_DATA_HOME=$root/data XDG_CACHE_HOME=$root/cache
export XDG_RUNTIME_DIR=$runtime
export GHOSTS_ROOT=$root/ghosts
unset GHOSTD_CONFIG GHOSTD_HOOKS GHOSTD_API_TOKEN_FILE GHOST GHOST_SESSION XDG_DOCUMENTS_DIR

# The owner's theme colours, copied, so the window is checked in the look it will have.
if [[ -f $theme_colors ]]; then
  mkdir -p "$HOME/.local/state/omarchy/current/theme"
  cp "$theme_colors" "$HOME/.local/state/omarchy/current/theme/colors.toml"
  echo preview > "$HOME/.local/state/omarchy/current/theme.name"
fi

# Sample data in the products' documented folders.
mkdir -p "$HOME/Documents/Notes" "$HOME/Documents/Reminders" "$HOME/Downloads" \
  "$HOME/WhatsApp/+15550100/WhatsApp Chat - Sara" "$HOME/iCloud Drive"
printf '# Ferry trip\n\nThe boat leaves at nine from the north pier.\nTickets are in the blue folder.\n' > "$HOME/Documents/Notes/Ferry trip.md"
printf '# Packing\n\n- Sunscreen\n- Charger\n- Passports\n' > "$HOME/Documents/Notes/Packing.md"
printf -- '- [ ] Buy ferry tickets\n- [x] Book the hotel\n- [ ] Pack the blue folder\n' > "$HOME/Documents/Reminders/Trip.md"
printf -- '- [ ] Milk\n- [ ] Bread\n' > "$HOME/Documents/Reminders/Groceries.md"
printf '[11/18/26, 09:02:11] Sara: Are we still on for the boat tomorrow?\n[11/18/26, 09:03:40] You: Yes, nine at the north pier.\n[11/18/26, 09:04:02] Sara: I will meet you there.\n' \
  > "$HOME/WhatsApp/+15550100/WhatsApp Chat - Sara/_chat.txt"
printf 'Ferry timetable: north pier 09:00, 13:00, 17:00.\n' > "$HOME/Downloads/timetable.txt"

stub() {
  printf '#!/bin/sh\n%s\n' "$2" > "$root/bin/$1"
  chmod 755 "$root/bin/$1"
}
now_ms=$(( $(date +%s) * 1000 ))
stub recall "case \"\$1\" in config) printf '{\"roots\":[\"$HOME\"]}' ;; search) printf '{\"hits\":[]}' ;; esac"
stub icloud-notes "case \"\$1\" in
  list) printf '[{\"id\":\"n1\",\"path\":\"$HOME/Documents/Notes/Ferry trip.md\",\"title\":\"Ferry trip\",\"snippet\":\"The boat leaves at nine from the north pier.\",\"modified_ms\":$now_ms},{\"id\":\"n2\",\"path\":\"$HOME/Documents/Notes/Packing.md\",\"title\":\"Packing\",\"snippet\":\"Sunscreen, charger, passports\",\"modified_ms\":$(( now_ms - 86400000 ))}]' ;;
  read) printf '{\"title\":\"Ferry trip\",\"path\":\"$HOME/Documents/Notes/Ferry trip.md\",\"body\":\"The boat leaves at nine from the north pier.\\\\nTickets are in the blue folder.\"}' ;;
esac"
stub cloudmail "case \"\$1\" in
  inbox|search) printf '[{\"id\":\"t_1\",\"subject\":\"Your ferry booking\",\"snippet\":\"Two adults, north pier, 09:00.\",\"from\":{\"name\":\"Island Ferries\"},\"last_at\":$now_ms},{\"id\":\"t_2\",\"subject\":\"Hotel confirmation\",\"snippet\":\"Check-in from 14:00.\",\"from\":{\"name\":\"Harbour Hotel\"},\"last_at\":$(( now_ms - 7200000 ))}]' ;;
  thread) printf '{\"thread\":{\"subject\":\"Your ferry booking\"},\"messages\":[{\"from\":{\"name\":\"Island Ferries\",\"email\":\"bookings@example.com\"},\"date\":$now_ms,\"text\":\"Two adults, north pier, 09:00. Please arrive 15 minutes early.\"}]}' ;;
esac"
stub icloud-contacts "case \"\$1\" in
  list) printf '[{\"id\":\"c1\",\"name\":\"Sara Example\",\"company\":\"Island Ferries\",\"phones\":[{\"value\":\"+1 555 0100\"}],\"emails\":[{\"value\":\"sara@example.com\"}]}]' ;;
  show) printf '{\"id\":\"c1\",\"name\":\"Sara Example\",\"company\":\"Island Ferries\",\"phones\":[{\"label\":\"mobile\",\"value\":\"+1 555 0100\"}]}' ;;
esac"
stub cloud-calendar "printf '[{\"id\":\"e1\",\"title\":\"Ferry to the island\",\"start\":\"$(date -d tomorrow +%Y-%m-%d)T09:00:00+00:00\",\"end\":\"$(date -d tomorrow +%Y-%m-%d)T10:30:00+00:00\",\"all_day\":false,\"calendar\":\"Home\"}]'"
stub icloud-photos "case \"\$1\" in
  list) printf '[{\"id\":\"p1\",\"filename\":\"IMG_0001.HEIC\",\"created\":\"2026-11-13T06:40:22Z\",\"kind\":\"photo\",\"width\":4032,\"height\":3024}]' ;;
  info) printf '{\"id\":\"p1\",\"filename\":\"IMG_0001.HEIC\",\"kind\":\"photo\",\"albums\":[\"Trip\"]}' ;;
esac"
# The stand-ins, then only what ghostd and its file search need.
tools=$root/tools
mkdir -p "$tools"
for tool in rg fd fzf sh bash env cat printf date sed pdftotext; do
  path=$(command -v "$tool" 2>/dev/null) && ln -sf "$path" "$tools/$tool"
done
daemon_path=$root/bin:$tools:$(dirname "$bun_bin")

# A scratch ghostd on a spare port, with the stand-in model server.
port=$("$bun_bin" -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop();')
[[ $port != 7717 ]] || { echo "preview: refusing port 7717" >&2; exit 1; }
export GHOSTD_PORT=$port
printf '#!/bin/sh\nexec %q %q "$@"\n' "$bun_bin" "$here/fake-llama-server.ts" > "$root/bin/fake-llama-server"
chmod 755 "$root/bin/fake-llama-server"
: > "$root/model.gguf"
mkdir -p "$XDG_CONFIG_HOME/ghost"
printf '{"local":{"model":"%s","server":"%s"}}\n' "$root/model.gguf" "$root/bin/fake-llama-server" > "$XDG_CONFIG_HOME/ghost/config.json"
PATH=$daemon_path "$bun_bin" "$repo/packages/daemon/src/main.ts" > "$root/ghostd.log" 2>&1 &
daemon_pid=$!
token_file=$XDG_STATE_HOME/ghost/api-token
for _ in {1..100}; do
  [[ -s $token_file ]] && curl -fsS -o /dev/null -H "Authorization: Bearer $(cat "$token_file")" "http://127.0.0.1:$port/api/ghosts" 2>/dev/null && break
  kill -0 "$daemon_pid" 2>/dev/null || { echo "preview: ghostd exited" >&2; sed -n '1,40p' "$root/ghostd.log" >&2; exit 1; }
  sleep 0.1
done
curl -fsS -o /dev/null -X POST -H "Authorization: Bearer $(cat "$token_file")" -H 'content-type: application/json' \
  -d '{"name":"casper"}' "http://127.0.0.1:$port/api/ghosts"

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
  'hl.monitor({ output = "", mode = "1280x820@60", position = "0x0", scale = 1 })' \
  'hl.config({' \
  '  general = { gaps_in = 0, gaps_out = 0, border_size = 0 },' \
  '  decoration = { rounding = 0, shadow = { enabled = false }, blur = { enabled = false } },' \
  '  animations = { enabled = false },' \
  '  misc = { disable_hyprland_logo = true, disable_splash_rendering = true },' \
  '})' > "$root/hyprland.lua"
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

GHOST_WINDOW_OPEN=$route GDK_BACKEND=wayland "$binary" > "$root/window.log" 2>&1 &
window_pid=$!
# The window, then what the route loads (an asked question's answer most of all).
sleep "${GHOST_WINDOW_SETTLE:-4}"
kill -0 "$window_pid" 2>/dev/null || { echo "preview: the window exited" >&2; sed -n '1,40p' "$root/window.log" >&2; exit 1; }
mkdir -p "$(dirname "$screenshot")"
/usr/bin/grim "$screenshot"
echo "preview: $screenshot"
[[ ! -s $root/window.log ]] || sed -n '1,20p' "$root/window.log" >&2
