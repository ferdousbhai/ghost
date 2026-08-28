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
commit=0000000000000000000000000000000000000000
epoch=1
runtime_root="$work/runtime"
mkdir -p "$runtime_root/bin"

cat > "$work/ghostd.ts" <<EOF
if (process.argv.includes("--help")) {
  console.log("Usage:\\n  ghostd [options]");
} else if (process.argv.includes("--version")) {
  console.log("$version");
} else {
  process.exitCode = 2;
}
EOF
bun build --compile --target=bun-linux-x64 "$work/ghostd.ts" \
  --outfile "$runtime_root/bin/ghostd"
chmod 755 "$runtime_root/bin/ghostd"

(
  cd "$runtime_root"
  sha256sum bin/ghostd > PAYLOAD.SHA256
)
cat > "$runtime_root/MANIFEST" <<EOF
format=ghost-runtime-source/v2
version=$version
os=linux
arch=x86_64
source_commit=$commit
source_date_epoch=$epoch
bun_version=$(bun --version)
compile_target=bun-linux-x64
payload_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)
EOF
chmod 644 "$runtime_root"/{MANIFEST,PAYLOAD.SHA256}

verify() {
  GHOST_RELEASE_WORK_ROOT="$work/verify-work" \
    bash "$script_dir/verify-runtime-source.sh" \
      "$1" "$source_root" "$version" x86_64 "$commit" "$epoch"
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
printf 'tampered\n' >> "$tampered/bin/ghostd"
assert_rejected "$tampered" 'runtime payload hashes do not match'

wrong_target="$work/wrong-target"
cp -a "$runtime_root" "$wrong_target"
sed -i 's/^compile_target=.*/compile_target=bun-linux-arm64/' \
  "$wrong_target/MANIFEST"
assert_rejected "$wrong_target" 'unsupported compile_target'

non_executable="$work/non-executable"
cp -a "$runtime_root" "$non_executable"
chmod 644 "$non_executable/bin/ghostd"
assert_rejected "$non_executable" 'runtime binary is not executable'

linked="$work/linked"
cp -a "$runtime_root" "$linked"
ln -s bin/ghostd "$linked/ghostd"
assert_rejected "$linked" 'runtime source contains a special filesystem entry'

printf 'Runtime source verifier regression passed\n'
