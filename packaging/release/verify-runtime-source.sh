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
binary="$runtime_root/bin/ghostd"

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
  $'f\tFROZEN-INPUTS.SHA256' \
  $'f\tMANIFEST' \
  $'f\tPAYLOAD.MODES' \
  $'f\tPAYLOAD.SHA256' \
  $'f\tbin/ghostd' \
  | LC_ALL=C sort > "$temporary/layout.expected"
require_identical "$temporary/layout.expected" "$temporary/layout.actual" \
  'runtime source does not have the v2 single-binary layout'

cat > "$temporary/MANIFEST.expected" <<EOF
format=ghost-runtime-source/v2
version=$version
os=linux
arch=$arch
source_commit=$commit
source_date_epoch=$epoch
frozen_inputs_sha256=$(sha256sum "$runtime_root/FROZEN-INPUTS.SHA256" | cut -d' ' -f1)
payload_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)
modes_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.MODES" | cut -d' ' -f1)
EOF
require_identical "$temporary/MANIFEST.expected" "$manifest" \
  'runtime manifest does not match the expected v2 identity'

bash "$source_root/packaging/release/frozen-inputs.sh" "$source_root" \
  > "$temporary/FROZEN-INPUTS.SHA256"
require_identical "$temporary/FROZEN-INPUTS.SHA256" \
  "$runtime_root/FROZEN-INPUTS.SHA256" \
  'runtime frozen inputs do not match the tagged source'

(
  cd "$runtime_root"
  find bin -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$temporary/PAYLOAD.SHA256"
require_identical "$temporary/PAYLOAD.SHA256" \
  "$runtime_root/PAYLOAD.SHA256" \
  'runtime payload hashes do not match the staged binary'

(
  cd "$runtime_root"
  while IFS= read -r -d '' path; do
    kind=f
    [[ -d "$path" ]] && kind=d
    printf '%s\t%s\t%s\n' "$(stat -c '%a' "$path")" "$kind" "$path"
  done < <(find bin -print0 | LC_ALL=C sort -z)
) > "$temporary/PAYLOAD.MODES"
require_identical "$temporary/PAYLOAD.MODES" "$runtime_root/PAYLOAD.MODES" \
  'runtime payload modes do not match the staged binary'

[[ -x "$binary" ]] || {
  printf 'runtime binary is not executable: %s\n' "$binary" >&2
  exit 1
}
LC_ALL=C readelf -h "$binary" > "$temporary/elf-header"
grep -Eq '^[[:space:]]*Class:[[:space:]]+ELF64$' "$temporary/elf-header"
grep -Eq '^[[:space:]]*Data:[[:space:]]+2.s complement, little endian$' \
  "$temporary/elf-header"
grep -Eq '^[[:space:]]*Type:[[:space:]]+(EXEC|DYN)[[:space:]]' \
  "$temporary/elf-header"
grep -Eq '^[[:space:]]*Machine:[[:space:]]+Advanced Micro Devices X86-64$' \
  "$temporary/elf-header"

bash "$source_root/packaging/release/smoke-binary-runtime.sh" \
  "$binary" "$version" "$temporary/smoke"
printf 'Verified runtime source: %s\n' "$runtime_root"
