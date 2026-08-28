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

cat > "$work/ghostd.c" <<'EOF'
#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--help") == 0) {
    puts("Usage:\n  ghostd [options]");
    return 0;
  }
  if (argc == 2 && strcmp(argv[1], "--version") == 0) {
    puts(GHOST_TEST_VERSION);
    return 0;
  }
  return 2;
}
EOF
cc -O2 -DGHOST_TEST_VERSION="\"$version\"" "$work/ghostd.c" \
  -o "$runtime_root/bin/ghostd"
chmod 755 "$runtime_root/bin/ghostd"

bash "$script_dir/frozen-inputs.sh" "$source_root" \
  > "$runtime_root/FROZEN-INPUTS.SHA256"
(
  cd "$runtime_root"
  sha256sum bin/ghostd > PAYLOAD.SHA256
  printf '755\td\tbin\n755\tf\tbin/ghostd\n' > PAYLOAD.MODES
)
cat > "$runtime_root/MANIFEST" <<EOF
format=ghost-runtime-source/v2
version=$version
os=linux
arch=x86_64
source_commit=$commit
source_date_epoch=$epoch
frozen_inputs_sha256=$(sha256sum "$runtime_root/FROZEN-INPUTS.SHA256" | cut -d' ' -f1)
payload_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)
modes_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.MODES" | cut -d' ' -f1)
EOF
chmod 644 "$runtime_root"/{FROZEN-INPUTS.SHA256,MANIFEST,PAYLOAD.MODES,PAYLOAD.SHA256}

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

forged_inputs="$work/forged-inputs"
cp -a "$runtime_root" "$forged_inputs"
sed -i '1d' "$forged_inputs/FROZEN-INPUTS.SHA256"
frozen_hash="$(sha256sum "$forged_inputs/FROZEN-INPUTS.SHA256" | cut -d' ' -f1)"
sed -i "s/^frozen_inputs_sha256=.*/frozen_inputs_sha256=$frozen_hash/" \
  "$forged_inputs/MANIFEST"
assert_rejected "$forged_inputs" \
  'runtime frozen inputs do not match the tagged source'

linked="$work/linked"
cp -a "$runtime_root" "$linked"
ln -s bin/ghostd "$linked/ghostd"
assert_rejected "$linked" 'runtime source contains a special filesystem entry'

printf 'Runtime source verifier regression passed\n'
