#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
temp_base="${GHOST_OBSIDIAN_ACCEPTANCE_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-obsidian-acceptance.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

owner_home="$work/owner"
skill_dir="$owner_home/.agents/skills/obsidian-cli"
fake_cli="$work/obsidian"
call_log="$work/calls"
note_state="$work/note"
mkdir -p "$skill_dir"
printf '%s\n' \
  '---' \
  'name: obsidian-cli' \
  'description: Test fixture.' \
  '---' > "$skill_dir/SKILL.md"

cat > "$fake_cli" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\t' "$@" >> "${GHOST_OBSIDIAN_FAKE_CALL_LOG:?}"
printf '\n' >> "$GHOST_OBSIDIAN_FAKE_CALL_LOG"

if [[ "${1-}" == vault=* ]]; then
  shift
fi
command_name="${1-}"
shift || true

case "${GHOST_OBSIDIAN_FAKE_MODE:-ready}:$command_name" in
  unavailable:version)
    printf 'The CLI is unable to find Obsidian. Please make sure Obsidian is running and try again.\n'
    exit 0
    ;;
  old:version)
    printf '1.12.6 (installer 1.12.6)\n'
    ;;
  *:version)
    printf '1.13.7 (installer 1.13.7)\n'
    ;;
  *:read)
    path="${1#path=}"
    if [[ -f "$GHOST_OBSIDIAN_FAKE_NOTE_STATE" ]]; then
      cat -- "$GHOST_OBSIDIAN_FAKE_NOTE_STATE"
    else
      printf 'Error: File "%s" not found.\n' "$path"
    fi
    ;;
  *:create)
    path="${1#path=}"
    content="${2#content=}"
    printf '%b\n' "$content" > "$GHOST_OBSIDIAN_FAKE_NOTE_STATE"
    printf 'Created %s\n' "$path"
    ;;
  search-fails:search)
    printf '[]\n'
    ;;
  *:search)
    path="$(sed -n 's/^.*path=\([^[:space:]]*\).*$/\1/p' "$GHOST_OBSIDIAN_FAKE_CALL_LOG" | tail -n1)"
    printf '[{"path":"%s"}]\n' "$path"
    ;;
  *:tasks)
    cat -- "$GHOST_OBSIDIAN_FAKE_NOTE_STATE"
    ;;
  *:delete)
    find -P "$GHOST_OBSIDIAN_FAKE_NOTE_STATE" -delete
    ;;
  *)
    printf 'unexpected fake Obsidian command: %s\n' "$command_name" >&2
    exit 70
    ;;
esac
EOF
chmod 700 "$fake_cli"

run_acceptance() {
  env \
    GHOST_OBSIDIAN_OWNER_HOME="$owner_home" \
    GHOST_OBSIDIAN_CLI="$fake_cli" \
    GHOST_OBSIDIAN_FAKE_CALL_LOG="$call_log" \
    GHOST_OBSIDIAN_FAKE_NOTE_STATE="$note_state" \
    GHOST_OBSIDIAN_FAKE_MODE="${GHOST_OBSIDIAN_FAKE_MODE:-ready}" \
    bash "$script_dir/accept-obsidian.sh" "$@"
}

expect_failure() {
  local expected="$1"
  shift
  local output
  if output="$("$@" 2>&1)"; then
    printf 'expected command to fail: %s\n' "$*" >&2
    exit 1
  fi
  [[ "$output" == *"$expected"* ]] || {
    printf 'failure did not contain %s: %s\n' "$expected" "$output" >&2
    exit 1
  }
}

find -P "$skill_dir/SKILL.md" -delete
expect_failure 'missing upstream Obsidian CLI skill' run_acceptance
printf '%s\n' '---' 'name: obsidian-cli' 'description: Test fixture.' '---' \
  > "$skill_dir/SKILL.md"

: > "$call_log"
GHOST_OBSIDIAN_FAKE_MODE=unavailable \
  expect_failure 'unavailable or returned an invalid version' run_acceptance
[[ "$(wc -l < "$call_log")" -eq 1 ]]

: > "$call_log"
GHOST_OBSIDIAN_FAKE_MODE=old \
  expect_failure '1.12.7 or newer is required' run_acceptance
[[ "$(wc -l < "$call_log")" -eq 1 ]]

: > "$call_log"
run_acceptance --vault 'Owner Notes' >/dev/null
[[ ! -e "$note_state" ]]
if grep -Ev $'^vault=Owner Notes\t' "$call_log" | grep -q .; then
  printf 'vault selection was not the first CLI parameter\n' >&2
  exit 1
fi
grep -Fq $'delete\tpath=ghost-obsidian-acceptance-' "$call_log"
grep -Fq $'permanent\t' "$call_log"

: > "$call_log"
GHOST_OBSIDIAN_FAKE_MODE=search-fails \
  expect_failure 'search did not find the acceptance note' run_acceptance
[[ ! -e "$note_state" ]]
grep -Fq $'delete\tpath=ghost-obsidian-acceptance-' "$call_log"
grep -Fq $'permanent\t' "$call_log"

printf 'Obsidian readiness acceptance regression passed\n'
