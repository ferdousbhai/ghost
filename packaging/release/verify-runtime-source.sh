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
work_parent="${GHOST_RELEASE_WORK_ROOT:-$(dirname "$runtime_root")}"
mkdir -p "$work_parent"
temporary="$(mktemp -d "$work_parent/verify.XXXXXX")"
cleanup() {
  find -P "$temporary" -depth -delete
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

if find -P "$runtime_root" ! \( -type f -o -type d \) \
  -print -quit | grep -q .; then
  printf 'runtime source contains a special filesystem entry\n' >&2
  exit 1
fi

(
  cd "$runtime_root"
  find . -maxdepth 1 -mindepth 1 -printf '%y\t%P\n' | LC_ALL=C sort
) > "$temporary/top-level.actual"
printf '%s\n' \
  $'d\tbin' \
  $'d\tlib' \
  $'d\tlicenses' \
  $'f\tBUNDLED-LICENSES' \
  $'f\tMANIFEST' \
  $'f\tPAYLOAD.SHA256' \
  | LC_ALL=C sort > "$temporary/top-level.expected"
require_identical "$temporary/top-level.expected" "$temporary/top-level.actual" \
  'runtime source does not have the v3 top-level layout'

(
  cd "$runtime_root/bin"
  find . -maxdepth 1 -mindepth 1 -printf '%y\t%P\n' | LC_ALL=C sort
) > "$temporary/bin.actual"
printf '%s\n' \
  $'f\tghost' \
  $'f\tghostd' \
  | LC_ALL=C sort > "$temporary/bin.expected"
require_identical "$temporary/bin.expected" "$temporary/bin.actual" \
  'runtime source does not have the exact v3 binary closure'

(
  cd "$runtime_root/lib"
  find . -maxdepth 1 -mindepth 1 -printf '%y\t%P\n' | LC_ALL=C sort
) > "$temporary/lib.actual"
printf '%s\n' \
  $'f\tghost.js' \
  $'f\tghostd.js' \
  $'f\tphoton_rs_bg.wasm' \
  | LC_ALL=C sort > "$temporary/lib.expected"
require_identical "$temporary/lib.expected" "$temporary/lib.actual" \
  'runtime source does not have the exact v3 library closure'

if find -P "$runtime_root" -type d -empty -print -quit | grep -q .; then
  printf 'runtime source contains an empty directory outside its file closure\n' >&2
  exit 1
fi

if find -P "$runtime_root" -type d ! -perm 755 -print -quit | grep -q .; then
  printf 'runtime source contains a directory with an unsafe mode\n' >&2
  exit 1
fi
if find -P "$runtime_root" -type f ! -path "$runtime_root/bin/ghost" \
  ! -path "$runtime_root/bin/ghostd" ! -perm 644 -print -quit | grep -q .; then
  printf 'runtime source contains a data file with an unsafe mode\n' >&2
  exit 1
fi

for path in bin/ghost bin/ghostd; do
  [[ -f "$runtime_root/$path" && -x "$runtime_root/$path" \
    && "$(stat -c '%a' "$runtime_root/$path")" == 755 ]] || {
    printf 'runtime launcher is missing or unsafe: %s\n' "$path" >&2
    exit 1
  }
  grep -Fq 'GHOST_BUN_EXECUTABLE:-/usr/bin/bun' "$runtime_root/$path"
done
for path in lib/ghost.js lib/ghostd.js lib/photon_rs_bg.wasm BUNDLED-LICENSES; do
  [[ -f "$runtime_root/$path" && "$(stat -c '%a' "$runtime_root/$path")" == 644 ]] || {
    printf 'runtime data file is missing or unsafe: %s\n' "$path" >&2
    exit 1
  }
done
wasm_size="$(stat -c '%s' "$runtime_root/lib/photon_rs_bg.wasm")"
(( wasm_size > 0 && wasm_size <= 4 * 1024 * 1024 )) || {
  printf 'runtime Photon WASM has an invalid size: %s\n' "$wasm_size" >&2
  exit 1
}

bun_build_version="$(sed -n 's/^bun_build_version=//p' "$manifest")"
bun_runtime_min="$(sed -n 's/^bun_runtime_min=//p' "$manifest")"
[[ "$bun_build_version" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ \
  && "$bun_runtime_min" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] || {
  printf 'runtime manifest has an invalid Bun version\n' >&2
  exit 1
}
declared_min="$(bun -e '
  const p = await Bun.file(process.argv[1]).json();
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(p.engines?.bun ?? "");
  if (!match) process.exit(1);
  process.stdout.write(match[1]);
' "$source_root/packages/daemon/package.json")"
[[ "$bun_runtime_min" == "$declared_min" ]] || {
  printf 'runtime Bun minimum %s does not match package engine %s\n' \
    "$bun_runtime_min" "$declared_min" >&2
  exit 1
}
version_at_least() {
  [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | head -n1)" == "$2" ]]
}
version_at_least "$bun_build_version" "$bun_runtime_min" || {
  printf 'build Bun %s predates runtime minimum %s\n' \
    "$bun_build_version" "$bun_runtime_min" >&2
  exit 1
}
current_bun="$(bun --version)"
[[ "$current_bun" =~ ^[0-9]+[.][0-9]+[.][0-9]+$ ]] \
  && version_at_least "$current_bun" "$bun_runtime_min" || {
  printf 'installed Bun %s does not satisfy runtime minimum %s\n' \
    "$current_bun" "$bun_runtime_min" >&2
  exit 1
}

cat > "$temporary/MANIFEST.expected" <<EOF
format=ghost-runtime-source/v3
version=$version
os=linux
arch=$arch
source_commit=$commit
source_date_epoch=$epoch
bun_build_version=$bun_build_version
bun_runtime_min=$bun_runtime_min
bundle_target=bun
bundled_license_manifest_sha256=$(sha256sum "$runtime_root/BUNDLED-LICENSES" | cut -d' ' -f1)
payload_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)
EOF
require_identical "$temporary/MANIFEST.expected" "$manifest" \
  'runtime manifest does not match the expected v3 identity'

(
  cd "$runtime_root"
  find . -type f ! -name MANIFEST ! -name PAYLOAD.SHA256 -printf '%P\0' \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum
) > "$temporary/PAYLOAD.expected"
require_identical "$temporary/PAYLOAD.expected" "$runtime_root/PAYLOAD.SHA256" \
  'runtime payload hashes or file closure do not match'
(cd "$runtime_root" && sha256sum -c PAYLOAD.SHA256)

bun "$source_root/packages/daemon/scripts/verify-runtime-licenses.ts" "$runtime_root"
bash "$source_root/packaging/release/smoke-binary-runtime.sh" \
  "$runtime_root/bin/ghostd" "$runtime_root/bin/ghost" "$version" "$temporary/smoke"
printf 'Verified runtime source: %s (build Bun %s, runtime >= %s)\n' \
  "$runtime_root" "$bun_build_version" "$bun_runtime_min"
