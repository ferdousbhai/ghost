#!/usr/bin/env bash
# resolve-installer.sh tells publish.sh what the public one-liner serves, and
# publish.sh decides from its exit status whether a rollback has an installer
# to land on. So each status is proven against a fabricated redirect chain on
# loopback, shaped like the real one (site -> latest -> tag -> CDN), with no
# network.
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
command -v python >/dev/null || {
  printf 'python is required to fabricate the redirect chain\n' >&2
  exit 1
}

temp_base="${GHOST_RELEASE_WORK_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-resolve-installer.XXXXXX")"
server=''
cleanup() {
  [[ -z "$server" ]] || kill "$server" 2>/dev/null || true
  find -P "$work" -depth -delete
}
trap cleanup EXIT

# Two sites over one server: /present's latest release carries install.sh,
# /missing's does not. /direct answers 200 without redirecting anywhere.
python - "$work/port" <<'PY' &
import http.server, sys

class Chain(http.server.BaseHTTPRequestHandler):
    def do_HEAD(self):
        base = 'http://127.0.0.1:%d' % self.server.server_port
        hops = {
            '/present/install.sh': base + '/present/releases/latest/download/install.sh',
            '/present/releases/latest/download/install.sh': base + '/present/releases/download/v1.2.3/install.sh',
            '/present/releases/download/v1.2.3/install.sh': base + '/cdn/blob',
            '/missing/install.sh': base + '/missing/releases/latest/download/install.sh',
            '/missing/releases/latest/download/install.sh': base + '/missing/releases/download/v0.0.9/install.sh',
        }
        if self.path in hops:
            self.send_response(302)
            self.send_header('Location', hops[self.path])
        elif self.path in ('/cdn/blob', '/direct/install.sh'):
            self.send_response(200)
        else:
            self.send_response(404)
        self.end_headers()

    do_GET = do_HEAD

    def log_message(self, *args):
        pass

httpd = http.server.HTTPServer(('127.0.0.1', 0), Chain)
with open(sys.argv[1], 'w') as handle:
    handle.write(str(httpd.server_port))
httpd.serve_forever()
PY
server=$!
for _ in $(seq 1 50); do
  [[ -s "$work/port" ]] && break
  sleep 0.1
done
[[ -s "$work/port" ]] || {
  printf 'the fabricated chain did not come up\n' >&2
  exit 1
}
base="http://127.0.0.1:$(cat "$work/port")"

probe() {
  local site="$1" releases="$2"
  GHOST_INSTALL_URL="$base/$site/install.sh" GHOST_RELEASES_URL="$base/$releases/releases" \
    bash "$script_dir/resolve-installer.sh" test/repo >"$work/out" 2>"$work/err" && status=0 || status=$?
}

probe present present
[[ "$status" -eq 0 && "$(cat "$work/out")" == v1.2.3 ]] || {
  printf 'FAIL a served installer should resolve to its tag: exit %s, stdout %s\n' "$status" "$(cat "$work/out")" >&2
  exit 1
}
printf 'ok a served installer resolves to its release tag\n'

probe missing missing
[[ "$status" -eq 2 && -z "$(cat "$work/out")" ]] && grep -qF 'v0.0.9 carries no install.sh' "$work/err" || {
  printf 'FAIL a latest release without install.sh should exit 2 and name the tag: exit %s, stderr %s\n' "$status" "$(cat "$work/err")" >&2
  exit 1
}
printf 'ok a latest release without install.sh is reported as serving nothing\n'

probe present missing
[[ "$status" -eq 1 ]] && grep -qF 'does not redirect to' "$work/err" || {
  printf 'FAIL a chain through another repository should exit 1: exit %s, stderr %s\n' "$status" "$(cat "$work/err")" >&2
  exit 1
}
printf 'ok a one-liner that redirects elsewhere is no release'"'"'s to fix\n'

probe direct present
[[ "$status" -eq 1 ]] && grep -qF 'does not redirect to' "$work/err" || {
  printf 'FAIL a one-liner served without the latest-release hop should exit 1: exit %s\n' "$status" >&2
  exit 1
}
printf 'ok a one-liner served outside the release chain is refused\n'

probe nowhere nowhere
[[ "$status" -eq 1 ]] || {
  printf 'FAIL an unreachable one-liner should exit 1: exit %s\n' "$status" >&2
  exit 1
}
printf 'ok an unanswered one-liner is a probe failure, not a missing installer\n'
