# Sourced by qa.sh: a scratch owner home seeded with sample data, under the caller's private `$root`,
# and a scratch ghostd against it. Private HOME and XDG directories, stand-in product CLIs and a stand-in model
# server: never the owner's ghosts, data, accounts, session bus, or port 7717.
#
#   stand_in_home      exports HOME, the XDG directories and GHOSTS_ROOT under $root, and seeds them
#   stand_in_ghostd    starts ghostd on a spare port (sets daemon_pid, exports GHOSTD_PORT) with the ghost home its first start makes
#
# The caller sets `root` (an empty directory of its own) and a private XDG_RUNTIME_DIR, and kills `daemon_pid` when
# it ends.
stand_in_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
stand_in_repo=$(realpath -e -- "$stand_in_dir/../../..")
stand_in_bun=$(command -v bun) || { echo "stand-in: bun is required" >&2; exit 1; }

stand_in_home() {
  mkdir -p "$root"/{home,config,state,data,cache,ghosts,bin}
  export HOME=$root/home
  export XDG_CONFIG_HOME=$root/config XDG_STATE_HOME=$root/state XDG_DATA_HOME=$root/data XDG_CACHE_HOME=$root/cache
  export GHOSTS_ROOT=$root/ghosts
  unset GHOSTD_CONFIG GHOSTD_HOOKS GHOSTD_API_TOKEN_FILE GHOSTD_PORT GHOST_SESSION XDG_DOCUMENTS_DIR

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
  local now_ms=$(( $(date +%s) * 1000 ))
  stub icloud-session "printf '{\"signed_in\":true,\"apple_id\":\"sam@example.com\"}'"
  stub recall "case \"\$1\" in status) printf '{\"state\":\"idle\",\"files\":1204,\"searchable\":1198}' ;; config) printf '{\"roots\":[\"$HOME\"]}' ;; search) printf '{\"hits\":[]}' ;; esac"
  stub cloudmail "case \"\$1\" in
  inbox|search) printf '[{\"id\":\"t_1\",\"subject\":\"Your ferry booking\",\"snippet\":\"Two adults, north pier, 09:00.\",\"from\":{\"name\":\"Island Ferries\"},\"last_at\":$now_ms},{\"id\":\"t_2\",\"subject\":\"Hotel confirmation\",\"snippet\":\"Check-in from 14:00.\",\"from\":{\"name\":\"Harbour Hotel\"},\"last_at\":$(( now_ms - 7200000 ))}]' ;;
  thread) printf '{\"thread\":{\"subject\":\"Your ferry booking\"},\"messages\":[{\"from\":{\"name\":\"Island Ferries\",\"email\":\"bookings@example.com\"},\"date\":$now_ms,\"text\":\"Two adults, north pier, 09:00. Please arrive 15 minutes early.\"}]}' ;;
esac"
  stub cloud-contacts "case \"\$1\" in
  list) printf '[{\"id\":\"c1\",\"name\":\"Sara Example\",\"company\":\"Island Ferries\",\"phones\":[{\"value\":\"+1 555 0100\"}],\"emails\":[{\"value\":\"sara@example.com\"}]}]' ;;
  show) printf '{\"id\":\"c1\",\"name\":\"Sara Example\",\"company\":\"Island Ferries\",\"phones\":[{\"label\":\"mobile\",\"value\":\"+1 555 0100\"}]}' ;;
esac"
  stub cloud-calendar "printf '[{\"id\":\"e1\",\"title\":\"Ferry to the island\",\"start\":\"$(date -d tomorrow +%Y-%m-%d)T09:00:00+00:00\",\"end\":\"$(date -d tomorrow +%Y-%m-%d)T10:30:00+00:00\",\"all_day\":false,\"calendar\":\"Home\"}]'"
  stub icloud-photos "case \"\$1\" in
  list) printf '[' ; for n in 1 2 3 4 5 6 7; do printf '{\"id\":\"p%s\",\"filename\":\"IMG_000%s.HEIC\",\"created\":\"2026-11-1%sT06:40:22Z\",\"kind\":\"photo\",\"width\":4032,\"height\":3024},' \$n \$n \$n; done; printf '{\"id\":\"p8\",\"filename\":\"IMG_0008.MOV\",\"created\":\"2026-11-09T06:40:22Z\",\"kind\":\"video\",\"width\":1920,\"height\":1080}]' ;;
  thumb) printf '{\"id\":\"%s\",\"path\":\"$root/pictures/%s.png\"}' \"\$4\" \"\$4\" ;;
  info) printf '{\"id\":\"p1\",\"filename\":\"IMG_0001.HEIC\",\"created\":\"2026-11-11T06:40:22Z\",\"kind\":\"photo\",\"width\":4032,\"height\":3024,\"size\":2100000,\"albums\":[{\"id\":\"a1\",\"name\":\"Trip\"}]}' ;;
esac"
  mkdir -p "$root/pictures"
  "$stand_in_bun" "$stand_in_dir/sample-picture.ts" "$root/pictures" 8
}

stand_in_ghostd() {
  # The stand-ins, then only what ghostd and its file search need.
  local tools=$root/tools tool path
  mkdir -p "$tools"
  for tool in rg fd fzf sh bash env cat printf date sed pdftotext; do
    path=$(command -v "$tool" 2>/dev/null) && ln -sf "$path" "$tools/$tool"
  done
  # bun by link, not by its directory: /usr/bin would bring the owner's real product CLIs and accounts with it.
  ln -sf "$stand_in_bun" "$tools/bun"

  # A spare port, with the stand-in model server.
  local port
  port=$("$stand_in_bun" -e 'const s = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } }); console.log(s.port); s.stop();')
  [[ $port != 7717 ]] || { echo "stand-in: refusing port 7717" >&2; exit 1; }
  export GHOSTD_PORT=$port
  printf '#!/bin/sh\nexec %q %q "$@"\n' "$stand_in_bun" "$stand_in_dir/fake-llama-server.ts" > "$root/bin/fake-llama-server"
  chmod 755 "$root/bin/fake-llama-server"
  : > "$root/model.gguf"
  mkdir -p "$XDG_CONFIG_HOME/ghost"
  printf '{"local":{"model":"%s","server":"%s"}}\n' "$root/model.gguf" "$root/bin/fake-llama-server" > "$XDG_CONFIG_HOME/ghost/config.json"
  # No session bus: nothing ghostd might announce reaches the desktop this runs from.
  PATH=$root/bin:$tools DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent \
    "$stand_in_bun" "$stand_in_repo/packages/daemon/src/main.ts" > "$root/ghostd.log" 2>&1 &
  daemon_pid=$!
  local token_file=$XDG_STATE_HOME/ghost/api-token
  for _ in {1..100}; do
    [[ -s $token_file ]] && curl -fsS -o /dev/null -H "Authorization: Bearer $(cat "$token_file")" "http://127.0.0.1:$port/api/ghost" 2>/dev/null && break
    kill -0 "$daemon_pid" 2>/dev/null || { echo "stand-in: ghostd exited" >&2; sed -n '1,40p' "$root/ghostd.log" >&2; exit 1; }
    sleep 0.1
  done
}
