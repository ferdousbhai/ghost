# Sourced by qa.sh: a scratch owner home under the caller's private `$root`, and a scratch ghostd against it.
# Private HOME and XDG directories and a stand-in model server: never the owner's ghost, data, accounts,
# session bus, or port 7717.
#
#   stand_in_home      exports HOME, the XDG directories and GHOST_HOME under $root
#   stand_in_ghostd    starts ghostd on a spare port (sets daemon_pid, exports GHOSTD_PORT) with the ghost home its first start makes
#   stand_in_serve     starts what Tailscale Serve is to that ghostd, but for the TLS (sets serve_pid and serve_port):
#                      a loopback port whose requests reach it stamped as its owner's tailnet login, so a client
#                      whose `GHOST_AT` is `http://127.0.0.1:$serve_port` is taken for the owner's with no token
#   stand_in_tailnet <dir> [name ...]  makes <dir>/bin/tailscale, a `tailscale` whose `status --json` is a signed-in
#                      node with those machines as its owner's others, each on: put first on a bar's PATH, it is the
#                      tailnet that bar looks for ghosts on. A name is a machine's MagicDNS name, read as any address
#                      is, so `http://localhost:$serve_port` is a machine called localhost whose ghost is the stand-in
#
# The caller sets `root` (an empty directory of its own) and a private XDG_RUNTIME_DIR, and kills `daemon_pid` and
# `serve_pid` when it ends.
stand_in_dir=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
stand_in_repo=$(realpath -e -- "$stand_in_dir/../../..")
# rustup's own directory when no cargo is on PATH.
command -v cargo >/dev/null || PATH="$HOME/.cargo/bin:$PATH"
# The daemon and the stand-in tools (packages/daemon/examples/stand_in.rs), as release builds: the daemon is the
# one the gate has just built and tested, so only the stand-in is compiled for this.
(cd "$stand_in_repo" && cargo build --release --locked --quiet -p ghostd --bin ghostd --example stand_in)
stand_in_ghostd_binary=$stand_in_repo/target/release/ghostd
stand_in_tool=$stand_in_repo/target/release/examples/stand_in
# The tailnet login the scratch ghostd takes for its owner's (`remote.owner`), so it asks no Tailscale who that is.
stand_in_owner=owner@example.com

stand_in_home() {
  mkdir -p "$root"/{home,config,state,data,cache,bin}
  export HOME=$root/home
  export XDG_CONFIG_HOME=$root/config XDG_STATE_HOME=$root/state XDG_DATA_HOME=$root/data XDG_CACHE_HOME=$root/cache
  export GHOST_HOME=$root/ghost
  unset GHOSTD_CONFIG GHOSTD_HOOKS GHOSTD_API_TOKEN_FILE GHOSTD_PORT XDG_DOCUMENTS_DIR
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
  printf '{"local":{"model":"%s","server":"%s"},"remote":{"owner":"%s"}}\n' "$root/model.gguf" "$root/bin/fake-llama-server" "$stand_in_owner" \
    > "$XDG_CONFIG_HOME/ghost/config.json"
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

stand_in_serve() {
  serve_port=$("$stand_in_tool" port)
  [[ $serve_port != 7717 ]] || { echo "stand-in: refusing port 7717" >&2; exit 1; }
  "$stand_in_tool" serve "$serve_port" "$GHOSTD_PORT" "$stand_in_owner" > "$root/serve.log" 2>&1 &
  serve_pid=$!
  for _ in {1..100}; do
    curl -fsS -o /dev/null "http://127.0.0.1:$serve_port/api/remote/whoami" 2>/dev/null && break
    kill -0 "$serve_pid" 2>/dev/null || { echo "stand-in: serve exited" >&2; cat "$root/serve.log" >&2; exit 1; }
    sleep 0.1
  done
}

stand_in_tailnet() {
  local dir=$1 peers="" name index=0
  shift
  for name in "$@"; do
    peers+="${peers:+,}\"key$index\":{\"DNSName\":\"$name.\",\"UserID\":42,\"Online\":true,\"OS\":\"linux\"}"
    index=$((index + 1))
  done
  mkdir -p "$dir/bin"
  printf '#!/bin/sh\nprintf %%s %q\n' \
    "{\"BackendState\":\"Running\",\"Self\":{\"DNSName\":\"laptop.example.ts.net.\",\"UserID\":42},\"Peer\":{$peers},\"User\":{\"42\":{\"LoginName\":\"$stand_in_owner\"}}}" \
    > "$dir/bin/tailscale"
  chmod 755 "$dir/bin/tailscale"
}
