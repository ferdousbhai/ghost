#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_dir/../..")"
checker="$script_dir/verify-release-version.sh"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-release-version.XXXXXX")"
trap 'find -P "$work" -depth -delete' EXIT

bash "$checker" "$source_root" >/dev/null
bash "$checker" --valid 1.20.3

# publish.sh asks the same rule of a requested version before it bumps.
for invalid in 1.2.3.alpha 01.2.3 0.0.0; do
  if bash "$checker" --valid "$invalid" 2>/dev/null; then
    printf 'release version checker accepted invalid requested version %s\n' "$invalid" >&2
    exit 1
  fi
  printf '{"version": "%s"}\n' "$invalid" > "$work/package.json"
  if bash "$checker" "$work" >/dev/null 2>&1; then
    printf 'release version checker accepted invalid manifest version %s\n' "$invalid" >&2
    exit 1
  fi
done

# The daemon carries no version of its own to fall out of step.
! grep -q '"version"' "$source_root/packages/daemon/package.json"

printf 'Release version check passed\n'
