#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_dir/../..")"
test_parent="${GHOST_RUNTIME_SOURCE_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$test_parent"
work="$(mktemp -d "$test_parent/ghost-runtime-source.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

version="$(bun -e 'process.stdout.write((await Bun.file(process.argv[1]).json()).version)' "$source_root/package.json")"
bun_build_version="$(bun --version)"
bun_runtime_min="$(bun -e '
  const manifest = await Bun.file(process.argv[1]).json();
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(manifest.engines?.bun ?? "");
  if (!match) process.exit(1);
  process.stdout.write(match[1]);
' "$source_root/packages/daemon/package.json")"
commit=0000000000000000000000000000000000000000
epoch=1
runtime_root="$work/runtime"
mkdir -p "$runtime_root/bin" "$runtime_root/lib" "$runtime_root/licenses/ghost" \
  "$runtime_root/licenses/npm/@earendil-works/pi-ai/0.86.0"
cp "$source_root/packages/daemon/scripts/launchers/ghostd" "$runtime_root/bin/ghostd"
cp "$source_root/packages/daemon/scripts/launchers/ghost" "$runtime_root/bin/ghost"
chmod 755 "$runtime_root/bin/ghostd" "$runtime_root/bin/ghost"

cat > "$runtime_root/lib/ghostd.js" <<EOF
if (process.argv.includes("--help")) {
  console.log("Usage:\\n  ghostd [options]");
} else if (process.argv.includes("--version")) {
  console.log("$version");
} else {
  process.exitCode = 2;
}
EOF
cat > "$runtime_root/lib/ghost.js" <<EOF
if (process.argv.includes("--help")) {
  console.log("Usage:\\n  ghost <verb> [args]");
} else if (process.argv.includes("--version")) {
  console.log("$version");
} else {
  process.exitCode = 2;
}
EOF
printf '\0asm\1\0\0\0' > "$runtime_root/lib/photon_rs_bg.wasm"
cp "$source_root/LICENSE" "$runtime_root/licenses/ghost/LICENSE"
cp "$source_root/THIRD_PARTY_NOTICES.md" \
  "$runtime_root/licenses/ghost/THIRD_PARTY_NOTICES.md"
cp "$source_root/packages/daemon/scripts/runtime-licenses/earendil-pi.LICENSE" \
  "$runtime_root/licenses/npm/@earendil-works/pi-ai/0.86.0/LICENSE"
cat > "$runtime_root/BUNDLED-LICENSES" <<EOF
format=ghost-bundled-licenses/v1
ghost	ghost-workspace	$version	Apache-2.0	licenses/ghost/LICENSE,licenses/ghost/THIRD_PARTY_NOTICES.md
npm	@earendil-works/pi-ai	0.86.0	MIT	licenses/npm/@earendil-works/pi-ai/0.86.0/LICENSE
EOF
find -P "$runtime_root" -type d -exec chmod 755 {} +
find -P "$runtime_root" -type f ! -path "$runtime_root/bin/*" -exec chmod 644 {} +

refresh_payload() {
  local root="$1"
  (
    cd "$root"
    find . -type f ! -name MANIFEST ! -name PAYLOAD.SHA256 -printf '%P\0' \
      | LC_ALL=C sort -z \
      | xargs -0 sha256sum > PAYLOAD.SHA256
  )
  cat > "$root/MANIFEST" <<EOF
format=ghost-runtime-source/v3
version=$version
os=linux
arch=any
source_commit=$commit
source_date_epoch=$epoch
bun_build_version=$bun_build_version
bun_runtime_min=$bun_runtime_min
bundle_target=bun
bundled_license_manifest_sha256=$(sha256sum "$root/BUNDLED-LICENSES" | cut -d' ' -f1)
payload_manifest_sha256=$(sha256sum "$root/PAYLOAD.SHA256" | cut -d' ' -f1)
EOF
  chmod 644 "$root/MANIFEST" "$root/PAYLOAD.SHA256"
}
refresh_payload "$runtime_root"

verify() {
  GHOST_RELEASE_WORK_ROOT="$work/verify-work" \
    bash "$script_dir/verify-runtime-source.sh" \
      "$1" "$source_root" "$version" any "$commit" "$epoch"
}

assert_rejected() {
  local candidate="$1"
  local expected="$2"
  if verify "$candidate" > "$work/rejected.out" 2>&1; then
    printf 'runtime verifier accepted invalid fixture: %s\n' "$candidate" >&2
    exit 1
  fi
  grep -Fq "$expected" "$work/rejected.out"
}

verify "$runtime_root"

tampered="$work/tampered"
cp -a "$runtime_root" "$tampered"
printf 'tampered\n' >> "$tampered/lib/ghostd.js"
assert_rejected "$tampered" 'runtime payload hashes or file closure do not match'

wrong_target="$work/wrong-target"
cp -a "$runtime_root" "$wrong_target"
sed -i 's/^bundle_target=.*/bundle_target=node/' "$wrong_target/MANIFEST"
assert_rejected "$wrong_target" 'runtime manifest does not match'

wrong_min="$work/wrong-min"
cp -a "$runtime_root" "$wrong_min"
sed -i 's/^bun_runtime_min=.*/bun_runtime_min=1.4.0/' "$wrong_min/MANIFEST"
assert_rejected "$wrong_min" 'does not match package engine'

non_executable="$work/non-executable"
cp -a "$runtime_root" "$non_executable"
chmod 644 "$non_executable/bin/ghost"
assert_rejected "$non_executable" 'runtime launcher is missing or unsafe'

missing_asset="$work/missing-asset"
cp -a "$runtime_root" "$missing_asset"
rm "$missing_asset/lib/photon_rs_bg.wasm"
refresh_payload "$missing_asset"
assert_rejected "$missing_asset" 'exact v3 library closure'

extra_binary="$work/extra-binary"
cp -a "$runtime_root" "$extra_binary"
printf '#!/bin/sh\nexit 0\n' > "$extra_binary/bin/debug"
chmod 755 "$extra_binary/bin/debug"
refresh_payload "$extra_binary"
assert_rejected "$extra_binary" 'exact v3 binary closure'

empty_directory="$work/empty-directory"
cp -a "$runtime_root" "$empty_directory"
mkdir "$empty_directory/licenses/empty"
chmod 755 "$empty_directory/licenses/empty"
refresh_payload "$empty_directory"
assert_rejected "$empty_directory" 'empty directory outside its file closure'

linked="$work/linked"
cp -a "$runtime_root" "$linked"
ln -s bin/ghostd "$linked/ghostd"
assert_rejected "$linked" 'runtime source contains a special filesystem entry'

unlicensed="$work/unlicensed"
cp -a "$runtime_root" "$unlicensed"
printf 'extra\n' > "$unlicensed/licenses/extra"
refresh_payload "$unlicensed"
assert_rejected "$unlicensed" 'does not exactly cover the licenses tree'

printf 'Runtime source verifier regression passed\n'
