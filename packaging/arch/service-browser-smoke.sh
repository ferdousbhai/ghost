#!/usr/bin/env bash
# Does the packaged install actually work from a real user session?
#
# Two questions, both only answerable on the owner's machine: can the packaged
# `ghost` reach the packaged `ghostd`, and is the browser relay endpoint the
# extension dials serving under the daemon's systemd hardening. Ghost never
# launches a browser itself — the relay dials out of a Chromium the owner
# started — so there is no launch policy left to prove here.
set -euo pipefail

systemctl --user is-active --quiet graphical-session.target
systemctl --user is-active --quiet ghostd.service

# `GET /api/relay/status` is deliberately exempt from the API token: it returns
# where to dial and whether an extension is connected, never the pairing token.
/usr/bin/ghost status --json | python -c '
import json
import sys
import urllib.error
import urllib.request

status = json.load(sys.stdin)
if status.get("reachable") is not True:
    raise SystemExit("ghost status did not report a reachable daemon")
print("Ghost terminal client reached the packaged daemon.")

daemon = status["daemon"].rstrip("/")
try:
    with urllib.request.urlopen(daemon + "/api/relay/status", timeout=10) as response:
        body = json.load(response)
except urllib.error.URLError as error:
    raise SystemExit("relay status was not reachable: " + str(error))

if not isinstance(body.get("path"), str):
    raise SystemExit("relay status did not name the socket path")
if body.get("enabled") is not True:
    raise SystemExit("the packaged daemon serves no relay endpoint")
print("Browser relay endpoint is serving from the packaged daemon.")
'
