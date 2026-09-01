#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath "$script_dir/../..")"
checker="$script_dir/check-native-task-scope-workflow.py"
workflow="$repo_root/.github/workflows/native-task-scope-integration.yml"
integration="$repo_root/packages/daemon/test/native-task-scope.real-integration.ts"
diagnostic="$repo_root/packages/daemon/test/native-task-scope-integration-diagnostic.ts"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-native-scope-workflow.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

python "$checker" "$workflow"

python - "$integration" "$diagnostic" <<'PY'
from pathlib import Path
import sys

integration = Path(sys.argv[1]).read_text(encoding="utf-8")
diagnostic = Path(sys.argv[2]).read_text(encoding="utf-8")
required = {
    "integration": (
        "launcherFailure: classifyLauncherStderr(",
        "readStageDiagnostic(stageReceipt)",
        "      scopeObservedOwnedLoaded,\n      scopeStatus,",
        "process.stderr.write(`${serializeLifecycleDiagnostic({",
    ),
    "diagnostic": (
        "constants.O_RDONLY | constants.O_NOFOLLOW",
        "stat.nlink === 1",
        "(stat.mode & 0o777) === 0o600",
        "const MAX_DIAGNOSTIC_BYTES = 2 * 1024",
    ),
}
for context, fragments in required.items():
    source = integration if context == "integration" else diagnostic
    for fragment in fragments:
        if source.count(fragment) != 1:
            raise SystemExit(f"native scope {context} diagnostic boundary changed: {fragment!r}")
for fragment in (
    "process.stderr.write(launcherStderr",
    "process.stderr.write(Buffer.concat(launcherStderr",
    "stderr: Buffer.concat(launcherStderr",
    "path: stageReceipt",
    "scopeUnit: unit",
):
    if fragment in integration:
        raise SystemExit(f"native scope diagnostic exposes private detail: {fragment!r}")
PY

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

expect_insert_rejected() {
  local name="$1"
  local marker="$2"
  local inserted="$3"
  python - "$workflow" "$work/$name.yml" "$marker" "$inserted" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1])
target = Path(sys.argv[2])
marker = sys.argv[3]
inserted = sys.argv[4]
text = source.read_text(encoding="utf-8")
if text.count(marker) != 1:
    raise SystemExit(f"fixture cannot locate {marker!r}")
target.write_text(text.replace(marker, f"{marker}\n{inserted}"), encoding="utf-8")
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
expect_rejected ci-guard '[[ "$CI" == true ]]' '[[ "$CI" == false ]]'
expect_rejected actions-guard '[[ "$GITHUB_ACTIONS" == true ]]' '[[ "$GITHUB_ACTIONS" == false ]]'
expect_rejected hosted-guard \
  '[[ "$RUNNER_ENVIRONMENT" == github-hosted ]]' \
  '[[ "$RUNNER_ENVIRONMENT" == self-hosted ]]'
expect_rejected linux-guard '[[ "$RUNNER_OS" == Linux ]]' '[[ "$RUNNER_OS" == Windows ]]'
expect_rejected pid1-guard \
  '[[ "$(cat /proc/1/comm)" == systemd ]]' \
  ': "PID 1 not checked"'
expect_rejected uid-guard \
  '[[ "$uid" =~ ^[0-9]+$ && "$uid" -gt 0 ]]' \
  '[[ "$uid" =~ ^[0-9]+$ ]]'
expect_rejected systemd-version \
  '[[ "$systemd_version" =~ ^[0-9]+$ && "$systemd_version" -ge 254 ]]' \
  '[[ "$systemd_version" =~ ^[0-9]+$ ]]'
expect_rejected home-canonical \
  '[[ "$HOME" == "$canonical_home" ]]' \
  '[[ -d "$HOME" ]]'
expect_rejected runtime-exact \
  'runtime_dir="/run/user/$uid"' \
  'runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$uid}"'
expect_rejected runtime-owner \
  '[[ "$(stat -c %u:%a "$runtime_dir")" == "$uid:700" ]]' \
  '[[ -d "$runtime_dir" ]]'
expect_rejected bus-present \
  '[[ -S "$bus_path" ]]' \
  '[[ -e "$bus_path" ]]'
expect_rejected bus-owner \
  '[[ "$(stat -c %u:%h "$bus_path")" == "$uid:1" ]]' \
  '[[ -S "$bus_path" ]]'
expect_rejected bus-address \
  'bus_address="unix:path=$bus_path"' \
  'bus_address="unix:abstract=ghost-ci"'
expect_rejected ambient-bus \
  'bus_address="unix:path=$bus_path"' \
  'bus_address="$DBUS_SESSION_BUS_ADDRESS"'
expect_rejected manager-probe \
  'systemctl --user show-environment >/dev/null' \
  ': "user manager environment not checked"'
expect_rejected run-id-bound \
  '[[ "$GITHUB_RUN_ID" =~ ^[1-9][0-9]{0,19}$ ]]' \
  '[[ -n "$GITHUB_RUN_ID" ]]'
expect_rejected random-suffix \
  'suffix="$(tr -d - < /proc/sys/kernel/random/uuid)"' \
  'suffix=constant'
expect_rejected unique-unit \
  'controller_unit="ghost-native-task-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${suffix}.service"' \
  'controller_unit=ghost-native-task-ci.service'
expect_rejected absent-unit \
  '[[ "$controller_load_state" == not-found ]]' \
  ': "existing controller unit accepted"'
expect_rejected controller-description \
  '"--description=$controller_description"' \
  '--description=unbound-controller'
expect_rejected controller-service-type '--service-type=exec' '--service-type=simple'
expect_rejected controller-slice '--slice=session.slice' '--slice=app.slice'
expect_rejected controller-wait '            --wait \' '            --no-block \'
expect_rejected controller-pipe '            --pipe \' '            --pty \'
expect_rejected finite-environment '            /usr/bin/env -i \' '            /usr/bin/env \'
expect_rejected integration-opt-in \
  '              GHOST_NATIVE_TASK_SCOPE_INTEGRATION=1 \' \
  '              GHOST_NATIVE_TASK_SCOPE_INTEGRATION=0 \'
expect_rejected exact-test-command \
  '              "$bun_bin" --bun "$test_file"' \
  '              bun packages/daemon/test/native-task-scope.real-integration.ts'
expect_rejected cleanup-description \
  '[[ "$initial_receipt" == "$controller_description" ]]' \
  '[[ -n "$initial_receipt" ]]'
expect_rejected cleanup-remaining-description \
  '[[ "$remaining_receipt" == "$controller_description" ]]' \
  '[[ -n "$remaining_receipt" ]]'
expect_rejected cleanup-confirmed \
  '[[ "$load_state" == not-found ]] || cleanup_status=1' \
  ': "controller cleanup not confirmed"'
expect_rejected diagnostic-status-scope \
  'systemctl --user --no-pager --full status "$controller_unit"' \
  'systemctl --user --no-pager --full status'
expect_rejected diagnostic-journal-scope \
  'journalctl --user --no-pager --lines=80 --unit "$controller_unit"' \
  'journalctl --user --no-pager --lines=80'
expect_rejected diagnostic-journal-bound \
  'journalctl --user --no-pager --lines=80' \
  'journalctl --user --no-pager --lines=200'
expect_insert_rejected forbidden-sudo \
  '          uid="$(id -u)"' \
  '          sudo true'
expect_insert_rejected forbidden-runuser \
  '          uid="$(id -u)"' \
  '          runuser -u runner -- true'
expect_insert_rejected forbidden-useradd \
  '          uid="$(id -u)"' \
  '          useradd synthetic-ci-user'
expect_insert_rejected forbidden-loginctl \
  '          uid="$(id -u)"' \
  '          loginctl enable-linger runner'
expect_insert_rejected forbidden-user-unit \
  '          uid="$(id -u)"' \
  '          systemctl start user@23456.service'
expect_insert_rejected forbidden-system-dropin \
  '          uid="$(id -u)"' \
  '          install -d /run/systemd/system/user@23456.service.d'
expect_insert_rejected forbidden-pattern-kill \
  '          uid="$(id -u)"' \
  '          pkill -f ghost-native-task'
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
