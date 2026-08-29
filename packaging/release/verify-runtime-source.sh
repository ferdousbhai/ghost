#!/usr/bin/env bash
set -euo pipefail

runtime_root="${1:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit> <epoch>}"
source_root="${2:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit> <epoch>}"
version="${3:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit> <epoch>}"
arch="${4:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit> <epoch>}"
commit="${5:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit> <epoch>}"
epoch="${6:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit> <epoch>}"

runtime_root="$(realpath "$runtime_root")"
source_root="$(realpath "$source_root")"
manifest="$runtime_root/MANIFEST"
daemon_binary="$runtime_root/bin/ghostd"
client_binary="$runtime_root/bin/ghost"

work_parent="${GHOST_RELEASE_WORK_ROOT:-$(dirname "$runtime_root")}"
mkdir -p "$work_parent"
temporary="$(mktemp -d "$work_parent/verify.XXXXXX")"
cleanup() {
  find "$temporary" -depth -delete
}
trap cleanup EXIT

require_identical() {
  local expected="$1"
  local actual="$2"
  local mismatch="$3"

  if ! cmp "$expected" "$actual"; then
    printf '%s\n' "$mismatch" >&2
    exit 1
  fi
}

if find "$runtime_root" ! \( -type f -o -type d \) \
  -print -quit | grep -q .; then
  printf 'runtime source contains a special filesystem entry\n' >&2
  exit 1
fi

(
  cd "$runtime_root"
  find . -mindepth 1 -printf '%y\t%P\n' | LC_ALL=C sort
) > "$temporary/layout.actual"
printf '%s\n' \
  $'d\tbin' \
  $'f\tMANIFEST' \
  $'f\tPAYLOAD.SHA256' \
  $'f\tbin/ghost' \
  $'f\tbin/ghostd' \
  | LC_ALL=C sort > "$temporary/layout.expected"
require_identical "$temporary/layout.expected" "$temporary/layout.actual" \
  'runtime source does not have the v2 two-binary layout'

bun_version="$(sed -n 's/^bun_version=//p' "$manifest")"
[[ "$bun_version" =~ ^[^[:space:]=]+$ ]] || {
  printf 'runtime manifest has an invalid bun_version\n' >&2
  exit 1
}
compile_target="$(sed -n 's/^compile_target=//p' "$manifest")"
[[ "$compile_target" == bun-linux-x64 ]] || {
  printf 'runtime manifest has an unsupported compile_target: %s\n' \
    "$compile_target" >&2
  exit 1
}

cat > "$temporary/MANIFEST.expected" <<EOF
format=ghost-runtime-source/v2
version=$version
os=linux
arch=$arch
source_commit=$commit
source_date_epoch=$epoch
bun_version=$bun_version
compile_target=$compile_target
payload_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)
EOF
require_identical "$temporary/MANIFEST.expected" "$manifest" \
  'runtime manifest does not match the expected v2 identity'
printf 'Runtime compiler: bun_version=%s compile_target=%s\n' \
  "$bun_version" "$compile_target"

[[ "$(wc -l < "$runtime_root/PAYLOAD.SHA256")" -eq 2 ]] \
  && sed -n '1p' "$runtime_root/PAYLOAD.SHA256" \
    | grep -Eq '^[0-9a-f]{64}  bin/ghost$' \
  && sed -n '2p' "$runtime_root/PAYLOAD.SHA256" \
    | grep -Eq '^[0-9a-f]{64}  bin/ghostd$' || {
  printf 'runtime payload checksum manifest is invalid\n' >&2
  exit 1
}
if ! (cd "$runtime_root" && sha256sum -c PAYLOAD.SHA256); then
  printf 'runtime payload hashes do not match the staged binary\n' >&2
  exit 1
fi

verify_binary() {
  local binary="$1"
  local label="$2"
  local elf_header="$temporary/$label.elf-header"

  [[ -x "$binary" ]] || {
    printf 'runtime binary is not executable: %s\n' "$binary" >&2
    return 1
  }
  LC_ALL=C readelf -h "$binary" > "$elf_header"
  grep -Eq '^[[:space:]]*Class:[[:space:]]+ELF64$' "$elf_header"
  grep -Eq '^[[:space:]]*Data:[[:space:]]+2.s complement, little endian$' \
    "$elf_header"
  grep -Eq '^[[:space:]]*Type:[[:space:]]+(EXEC|DYN)[[:space:]]' \
    "$elf_header"
  grep -Eq '^[[:space:]]*Machine:[[:space:]]+Advanced Micro Devices X86-64$' \
    "$elf_header"
}

verify_binary "$daemon_binary" ghostd
verify_binary "$client_binary" ghost

bash "$source_root/packaging/release/smoke-binary-runtime.sh" \
  "$daemon_binary" "$client_binary" "$version" "$temporary/smoke"
printf 'Verified runtime source: %s\n' "$runtime_root"
