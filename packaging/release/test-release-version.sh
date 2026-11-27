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
  printf '[workspace.package]\nversion = "%s"\n' "$invalid" > "$work/Cargo.toml"
  if bash "$checker" "$work" >/dev/null 2>&1; then
    printf 'release version checker accepted invalid manifest version %s\n' "$invalid" >&2
    exit 1
  fi
done

# Neither crate carries a version of its own to fall out of step.
for crate in daemon bar; do
  grep -Fxq 'version.workspace = true' "$source_root/packages/$crate/Cargo.toml"
done

printf 'Release version check passed\n'
