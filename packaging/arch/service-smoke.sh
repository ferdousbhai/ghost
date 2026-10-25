#!/usr/bin/env bash
# Read-only check of the installed terminal client and daemon.
set -euo pipefail
systemctl --user is-active --quiet ghostd.service
# status exits non-zero when it cannot reach the daemon.
/usr/bin/ghost status >/dev/null
echo 'Ghost terminal client reached the packaged daemon.'
