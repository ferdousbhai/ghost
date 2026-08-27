#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: frozen-inputs.sh <source-root>}"
source_root="$(realpath "$source_root")"

mapfile -t dependency_patches < <(
  awk '
    /^patchedDependencies:[[:space:]]*$/ { in_patches = 1; next }
    in_patches && /^[^[:space:]#]/ { exit }
    in_patches && /^[[:space:]]+[^#]/ {
      line = $0
      sub(/^[^:]+:[[:space:]]*/, "", line)
      quote = substr(line, 1, 1)
      if ((quote == "\"" || quote == sprintf("%c", 39)) \
          && substr(line, length(line), 1) == quote) {
        line = substr(line, 2, length(line) - 2)
      }
      print line
    }
  ' "$source_root/pnpm-workspace.yaml"
)
for patch in "${dependency_patches[@]}"; do
  case "$patch" in
    patches/*) ;;
    *)
      printf 'dependency patch must live under patches/: %s\n' "$patch" >&2
      exit 1
      ;;
  esac
  [[ -f "$source_root/$patch" ]] || {
    printf 'referenced dependency patch is missing: %s\n' "$patch" >&2
    exit 1
  }
done

(
  cd "$source_root"
  {
    printf '%s\0' package.json pnpm-lock.yaml pnpm-workspace.yaml
    printf '%s\0' "${dependency_patches[@]}"
    find packages -mindepth 2 -maxdepth 2 -type f -name package.json -print0
    find vendor/pi-catalog -type f -print0
  } | LC_ALL=C sort -zu | xargs -0 sha256sum
)
