# Sourced by qa.sh: a scratch owner home under the caller's private `$root`, and a scratch ghostd against it.
# Private HOME and XDG directories and a stand-in model server: never the owner's ghosts, data, accounts,
# session bus, or port 7717.
#
#   stand_in_home      exports HOME, the XDG directories and GHOSTS_ROOT under $root
#   stand_in_ghostd    starts ghostd on a spare port (sets daemon_pid, exports GHOSTD_PORT) with the ghost home its first start makes
#
# The caller sets `root` (an empty directory of its own) and a private XDG_RUNTIME_DIR, and kills `daemon_pid` when
# it ends.
stand_in_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
stand_in_repo=$(realpath -e -- "$stand_in_dir/../../..")
# The daemon and the stand-in tools (packages/daemon/examples/stand_in.rs), built once, as debug builds.
(cd "$stand_in_repo" && bash packages/window/dev/cargo.sh build --locked --quiet -p ghostd --bin ghostd --example stand_in)
stand_in_ghostd_binary=$stand_in_repo/target/debug/ghostd
stand_in_tool=$stand_in_repo/target/debug/examples/stand_in

stand_in_home() {
  mkdir -p "$root"/{home,config,state,data,cache,ghosts,bin}
  export HOME=$root/home
  export XDG_CONFIG_HOME=$root/config XDG_STATE_HOME=$root/state XDG_DATA_HOME=$root/data XDG_CACHE_HOME=$root/cache
  export GHOSTS_ROOT=$root/ghosts
  unset GHOSTD_CONFIG GHOSTD_HOOKS GHOSTD_API_TOKEN_FILE GHOSTD_PORT GHOST_SESSION XDG_DOCUMENTS_DIR
}

stand_in_ghostd() {
  # Only what ghostd needs.
  local tools=$root/tools tool path
  mkdir -p "$tools"
  # By link, not by their directory: /usr/bin would bring the owner's real product CLIs and accounts with it.
  for tool in sh bash env cat printf date sed gio git; do
    path=$(command -v "$tool" 2>/dev/null) && ln -sf "$path" "$tools/$tool"
  done

  # A spare port, with the stand-in model server.
  local port
  port=$("$stand_in_tool" port)
  [[ $port != 7717 ]] || { echo "stand-in: refusing port 7717" >&2; exit 1; }
  export GHOSTD_PORT=$port
  printf '#!/bin/sh\nexec %q llama-server "$@"\n' "$stand_in_tool" > "$root/bin/fake-llama-server"
  chmod 755 "$root/bin/fake-llama-server"
  : > "$root/model.gguf"
  mkdir -p "$XDG_CONFIG_HOME/ghost"
  printf '{"local":{"model":"%s","server":"%s"}}\n' "$root/model.gguf" "$root/bin/fake-llama-server" > "$XDG_CONFIG_HOME/ghost/config.json"
  # No session bus: nothing ghostd might announce reaches the desktop this runs from.
  PATH=$root/bin:$tools DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent \
    "$stand_in_ghostd_binary" > "$root/ghostd.log" 2>&1 &
  daemon_pid=$!
  local token_file=$XDG_STATE_HOME/ghost/api-token
  for _ in {1..100}; do
    [[ -s $token_file ]] && curl -fsS -o /dev/null -H "Authorization: Bearer $(cat "$token_file")" "http://127.0.0.1:$port/api/ghost" 2>/dev/null && break
    kill -0 "$daemon_pid" 2>/dev/null || { echo "stand-in: ghostd exited" >&2; sed -n '1,40p' "$root/ghostd.log" >&2; exit 1; }
    sleep 0.1
  done
}
