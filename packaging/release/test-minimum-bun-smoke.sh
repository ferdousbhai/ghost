#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
smoke="$script_dir/smoke-runtime-minimum-bun.sh"
# shellcheck source=smoke-runtime-minimum-bun.sh
source "$smoke"

temp_parent="${GHOST_MINIMUM_BUN_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_parent"
work="$(mktemp -d "$temp_parent/ghost-minimum-bun-test.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

mkdir -p "$work/fixture/bun-linux-x64"
cat > "$work/fixture/bun-linux-x64/bun" <<'EOF'
#!/usr/bin/env bash
printf '1.3.15\n'
EOF
chmod 755 "$work/fixture/bun-linux-x64/bun"
(cd "$work/fixture" && bsdtar -a -cf "$work/wrong-version.zip" bun-linux-x64)
actual_sha="$(sha256sum "$work/wrong-version.zip" | cut -d' ' -f1)"

if ghost_verify_minimum_bun_archive \
    "$work/wrong-version.zip" \
    0000000000000000000000000000000000000000000000000000000000000000 \
    1.3.14 "$work/checksum" \
    > "$work/checksum.out" 2>&1; then
  printf 'minimum Bun verifier accepted a wrong checksum\n' >&2
  exit 1
fi
grep -Fq 'does not match pinned' "$work/checksum.out"

if ghost_verify_minimum_bun_archive \
    "$work/wrong-version.zip" "$actual_sha" 1.3.14 "$work/version" \
    > "$work/version.out" 2>&1; then
  printf 'minimum Bun verifier accepted a wrong executable version\n' >&2
  exit 1
fi
grep -Fq 'expected exactly 1.3.14' "$work/version.out"

grep -Fq 'https://github.com/oven-sh/bun/releases/download/bun-v1.3.14/bun-linux-x64.zip' \
  "$smoke"
grep -Fq '951ee2aee855f08595aeec6225226a298d3fea83a3dcd6465c09cbccdf7e848f' \
  "$smoke"
grep -Fq 'GHOST_RUNTIME_SMOKE_BUN="$bun"' "$smoke"
if grep -Fq 7717 "$smoke" "$script_dir/ci-smoke-minimum-bun.sh"; then
  printf 'minimum Bun gate names the live daemon port\n' >&2
  exit 1
fi

printf 'Minimum Bun checksum/version mutation regression passed\n'
