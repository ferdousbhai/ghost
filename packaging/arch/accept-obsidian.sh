#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf 'usage: %s [--vault <name>]\n' "${0##*/}" >&2
}

vault_name=""
case "$#" in
  0) ;;
  2)
    [[ "$1" == "--vault" && -n "$2" ]] || {
      usage
      exit 2
    }
    vault_name="$2"
    ;;
  *)
    usage
    exit 2
    ;;
esac

if (( EUID == 0 )); then
  printf 'Obsidian readiness must run as the desktop owner, not root\n' >&2
  exit 1
fi

owner_home="${GHOST_OBSIDIAN_OWNER_HOME:-${HOME:?HOME is required}}"
obsidian_cli="${GHOST_OBSIDIAN_CLI:-obsidian}"
skill_path="$owner_home/.agents/skills/obsidian-cli/SKILL.md"

if [[ ! -f "$skill_path" ]]; then
  printf 'missing upstream Obsidian CLI skill: %s\n' "$skill_path" >&2
  printf '%s\n' \
    'install it with: npx -y skills@latest add https://github.com/kepano/obsidian-skills --global --yes --skill obsidian-cli' >&2
  exit 1
fi
if [[ "$obsidian_cli" == */* ]]; then
  [[ -x "$obsidian_cli" ]] || {
    printf 'Obsidian CLI is not executable: %s\n' "$obsidian_cli" >&2
    exit 1
  }
elif ! command -v "$obsidian_cli" >/dev/null; then
  printf 'Obsidian CLI is not registered in PATH\n' >&2
  exit 1
fi

run_obsidian() {
  if [[ -n "$vault_name" ]]; then
    "$obsidian_cli" "vault=$vault_name" "$@"
  else
    "$obsidian_cli" "$@"
  fi
}

version_output="$(run_obsidian version 2>&1)" || {
  printf 'Obsidian CLI version check failed: %s\n' "$version_output" >&2
  exit 1
}
if [[ ! "$version_output" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)([[:space:]]|$) ]]; then
  printf 'Obsidian CLI is unavailable or returned an invalid version: %s\n' \
    "$version_output" >&2
  exit 1
fi
version_major="${BASH_REMATCH[1]}"
version_minor="${BASH_REMATCH[2]}"
version_patch="${BASH_REMATCH[3]}"
if (( version_major < 1 \
  || (version_major == 1 && version_minor < 12) \
  || (version_major == 1 && version_minor == 12 && version_patch < 7) )); then
  printf 'Obsidian CLI 1.12.7 or newer is required; found %s.%s.%s\n' \
    "$version_major" "$version_minor" "$version_patch" >&2
  exit 1
fi

acceptance_id="$(date -u +%Y%m%dT%H%M%SZ)-$BASHPID"
note_path="ghost-obsidian-acceptance-$acceptance_id.md"
marker="ghost-obsidian-acceptance-$acceptance_id"
not_found="Error: File \"$note_path\" not found."
created=false

cleanup() {
  if [[ "$created" != true ]]; then
    return
  fi
  local current
  current="$(run_obsidian read "path=$note_path" 2>&1)" || true
  if [[ "$current" == *"$marker"* ]]; then
    run_obsidian delete "path=$note_path" permanent >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

existing="$(run_obsidian read "path=$note_path" 2>&1)" || true
if [[ "$existing" != "$not_found" ]]; then
  printf 'refusing to overwrite acceptance note: %s\n' "$note_path" >&2
  exit 1
fi

run_obsidian create "path=$note_path" \
  "content=# Ghost acceptance\n\n$marker\n\n- [ ] $marker task" >/dev/null
created=true

read_output="$(run_obsidian read "path=$note_path" 2>&1)"
[[ "$read_output" == *"$marker"* ]] || {
  printf 'Obsidian CLI did not read back the acceptance marker\n' >&2
  exit 1
}
search_output="$(run_obsidian search "query=$marker" format=json 2>&1)"
[[ "$search_output" == *"$note_path"* ]] || {
  printf 'Obsidian CLI search did not find the acceptance note\n' >&2
  exit 1
}
tasks_output="$(run_obsidian tasks "path=$note_path" todo format=json 2>&1)"
[[ "$tasks_output" == *"$marker task"* ]] || {
  printf 'Obsidian CLI did not list the acceptance task\n' >&2
  exit 1
}

# The note is already gone here, so do not hard-pin the CLI's exact error
# sentence: a rephrased "not found" message must not fail the run after the
# permanent delete. The marker's absence is the real deletion proof.
run_obsidian delete "path=$note_path" permanent >/dev/null
deleted="$(run_obsidian read "path=$note_path" 2>&1)" || true
if [[ "${deleted,,}" != *"not found"* ]]; then
  if [[ "$deleted" == *"$marker"* ]]; then
    printf 'Obsidian CLI acceptance note still resolves after deletion\n' >&2
  else
    printf 'unexpected post-delete read result: %s\n' "$deleted" >&2
  fi
  exit 1
fi
created=false
trap - EXIT

printf 'Obsidian %s.%s.%s readiness passed; permanently deleted %s\n' \
  "$version_major" "$version_minor" "$version_patch" "$note_path"
