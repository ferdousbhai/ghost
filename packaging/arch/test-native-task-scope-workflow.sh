#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath "$script_dir/../..")"
checker="$script_dir/check-native-task-scope-workflow.py"
workflow="$repo_root/.github/workflows/native-task-scope-integration.yml"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-native-scope-workflow.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

python "$checker" "$workflow"

expect_rejected() {
  local name="$1"
  local old="$2"
  local new="$3"
  python - "$workflow" "$work/$name.yml" "$old" "$new" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1])
target = Path(sys.argv[2])
old = sys.argv[3]
new = sys.argv[4]
text = source.read_text(encoding="utf-8")
if text.count(old) != 1:
    raise SystemExit(f"fixture cannot locate {old!r}")
target.write_text(text.replace(old, new), encoding="utf-8")
PY
  local output
  if output="$(python "$checker" "$work/$name.yml" 2>&1)"; then
    printf 'workflow checker accepted hostile fixture: %s\n' "$name" >&2
    exit 1
  fi
  if grep -Fq Traceback <<< "$output"; then
    printf 'workflow checker produced a traceback for %s:\n%s\n' "$name" "$output" >&2
    exit 1
  fi
}

expect_rejected runner 'runs-on: ubuntu-24.04' 'runs-on: ubuntu-latest'
expect_rejected ci-guard 'GITHUB_ACTIONS=true' 'GITHUB_ACTIONS=false'
expect_rejected opt-in \
  'GHOST_NATIVE_TASK_SCOPE_INTEGRATION=1' \
  'GHOST_NATIVE_TASK_SCOPE_INTEGRATION=0'
expect_rejected uid-guard \
  'test_uid=23456' \
  'test_uid="$(id -u)"'
expect_rejected manager-xdg-override \
  '"Environment=XDG_RUNTIME_DIR=/run/user/$test_uid"' \
  '"Environment=XDG_RUNTIME_DIR=/run/user/1001"'
expect_rejected manager-pam-reset \
  "            'PAMName=' \\" \
  "            'PAMName=systemd-user' \\"
expect_rejected manager-bus-override \
  '"Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$test_uid/bus"' \
  '"Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1001/bus"'
expect_rejected runtime-dir-start \
  'sudo systemctl start "$runtime_unit" "$manager_unit"' \
  'sudo systemctl start "$manager_unit"'
expect_rejected runtime-dir-active \
  'sudo systemctl is-active --quiet "$runtime_unit"' \
  ': "runtime directory activity not checked"'
expect_rejected manager-start \
  'sudo systemctl start "$runtime_unit" "$manager_unit"' \
  'sudo systemctl start "$runtime_unit"'
expect_rejected startup-order \
  $'          sudo systemctl is-active --quiet "$runtime_unit"\n          sudo systemctl is-active --quiet "$manager_unit"' \
  $'          sudo systemctl is-active --quiet "$manager_unit"\n          sudo systemctl is-active --quiet "$runtime_unit"'
expect_rejected bus-owner \
  '[[ "$(stat -c %u "/run/user/$test_uid/bus")" == "$test_uid" ]]' \
  '[[ -S "/run/user/$test_uid/bus" ]]'
expect_rejected diagnostic-status-scope \
  'sudo systemctl --no-pager --full status "$runtime_unit" "$manager_unit"' \
  'sudo systemctl --no-pager --full status'
expect_rejected diagnostic-journal-scope \
  $'            sudo journalctl --no-pager --lines=80 \\\n              --unit "$runtime_unit" \\\n              --unit "$manager_unit" || true' \
  '            sudo journalctl --no-pager --lines=80 || true'
expect_rejected diagnostic-journal-bound \
  'sudo journalctl --no-pager --lines=80' \
  'sudo journalctl --no-pager --lines=200'
expect_rejected cleanup-condition \
  "if: always() && steps.manager.outputs.test_user != ''" \
  'if: always()'
expect_rejected cleanup-runtime-dir \
  'sudo systemctl stop "user-runtime-dir@$TEST_UID.service" || true' \
  ': "runtime directory unit not stopped"'
expect_rejected cleanup-override \
  'sudo unlink -- "$override_file" || true' \
  ': "ephemeral manager override not removed"'
expect_rejected action-ref \
  'oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6' \
  'oven-sh/setup-bun@v2'
expect_rejected checkout-credentials-true \
  'persist-credentials: false' \
  'persist-credentials: true'
expect_rejected checkout-credentials-missing \
  $'        with:\n          persist-credentials: false\n' \
  ''

printf 'Native task systemd workflow hostile fixtures passed\n'
