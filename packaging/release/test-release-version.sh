#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_dir/../..")"
checker="$script_dir/verify-release-version.sh"
test_parent="${GHOST_RELEASE_VERSION_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$test_parent"
work="$(mktemp -d "$test_parent/ghost-release-version.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

# The browser extension lives in its own repository and versions on its own;
# PROTOCOL_VERSION is the only pin between it and a Ghost release.
manifests=(
  package.json
  packages/daemon/package.json
  packages/extensions/package.json
  packages/shell/package.json
  packages/shell/qml/manifest.json
)

expected="$(bash "$checker" "$source_root")"

fixture="$work/source"
for manifest in "${manifests[@]}"; do
  install -Dm644 "$source_root/$manifest" "$fixture/$manifest"
done
[[ "$(bash "$checker" "$fixture")" == "$expected" ]]

set_version() {
  local manifest="$1"
  local version="$2"

  bun -e '
    const path = process.argv[1];
    const version = process.argv[2];
    const document = await Bun.file(path).json();
    document.version = version;
    await Bun.write(path, `${JSON.stringify(document, null, 2)}\n`);
  ' "$fixture/$manifest" "$version"
}

set_common_version() {
  local version="$1"
  local manifest
  for manifest in "${manifests[@]}"; do
    set_version "$manifest" "$version"
  done
}

for invalid in 1.2.3.alpha 01.2.3 65536.0.0 0.0.0; do
  set_common_version "$invalid"
  if bash "$checker" "$fixture" > "$work/rejected.out" 2>&1; then
    printf 'release version checker accepted invalid common version %s\n' \
      "$invalid" >&2
    exit 1
  fi
  grep -Fq "package.json has invalid release version \"$invalid\"" \
    "$work/rejected.out"
done

set_common_version 65535.0.1
[[ "$(bash "$checker" "$fixture")" == 65535.0.1 ]]
for manifest in "${manifests[@]}"; do
  install -Dm644 "$source_root/$manifest" "$fixture/$manifest"
done

for manifest in "${manifests[@]:1}"; do
  set_version "$manifest" 9.9.9
  if bash "$checker" "$fixture" > "$work/rejected.out" 2>&1; then
    printf 'release version checker accepted mismatched %s\n' "$manifest" >&2
    exit 1
  fi
  grep -Fq "$manifest version 9.9.9 does not match release version $expected" \
    "$work/rejected.out"
  install -Dm644 "$source_root/$manifest" "$fixture/$manifest"
done

printf 'Release version parity passed\n'
