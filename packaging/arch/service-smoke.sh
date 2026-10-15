#!/usr/bin/env bash
# Read-only check of the installed terminal client and daemon.
set -euo pipefail
systemctl --user is-active --quiet ghostd.service
/usr/bin/ghost status --json | python -c '
import json, sys
if json.load(sys.stdin).get("reachable") is not True:
    raise SystemExit("ghost status did not report a reachable daemon")
print("Ghost terminal client reached the packaged daemon.")
'
