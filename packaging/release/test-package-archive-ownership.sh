#!/usr/bin/env bash

set -euo pipefail

(( EUID != 0 )) || {
  printf 'package ownership regression must run as the package builder\n' >&2
  exit 1
}

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
verifier="$script_dir/verify-package-archive-ownership.sh"
temp_base="${GHOST_RELEASE_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p -- "$temp_base"
work="$(mktemp -d "$temp_base/ghost-package-owner.XXXXXXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

payload="$work/payload"
mkdir -p -- "$payload/usr/bin" "$payload/path uid=99"
printf '#!/usr/bin/env bash\n' > "$payload/usr/bin/ghost-fixture"
printf 'metadata-looking path\n' > "$payload/path uid=99/value gid=88"
printf 'comment-looking path\n' > "$payload/#owner uid=777"
ln "$payload/usr/bin/ghost-fixture" "$payload/usr/bin/ghost-hardlink"
ln -s ghost-fixture "$payload/usr/bin/ghost-symlink"
chmod 755 -- "$payload/usr/bin/ghost-fixture"

root_archive="$work/root.pkg.tar.zst"
bsdtar -caf "$root_archive" --format=pax --uid 0 --gid 0 \
  -C "$payload" .
bash "$verifier" "$root_archive"

extracted="$work/extracted"
mkdir -- "$extracted"
bsdtar -xf "$root_archive" -C "$extracted"
[[ "$(stat -c '%u:%g' "$extracted/usr/bin/ghost-fixture")" == \
  "$EUID:$(id -g)" ]] || {
  printf 'unprivileged archive extraction did not retain builder ownership\n' >&2
  exit 1
}

assert_rejected() {
  local archive="$1" expected="$2" output="$work/rejected.out"
  if bash "$verifier" "$archive" > "$output" 2>&1; then
    printf 'ownership verifier accepted adversarial archive: %s\n' \
      "$archive" >&2
    exit 1
  fi
  grep -Fq "$expected" "$output"
}

uid_archive="$work/nonroot-uid.pkg.tar.zst"
bsdtar -caf "$uid_archive" --format=pax --uid 123 --gid 0 \
  -C "$payload" .
assert_rejected "$uid_archive" 'non-root ownership (123:0)'

gid_archive="$work/nonroot-gid.pkg.tar.zst"
bsdtar -caf "$gid_archive" --format=pax --uid 0 --gid 456 \
  -C "$payload" .
assert_rejected "$gid_archive" 'non-root ownership (0:456)'

mixed_tar="$work/mixed.tar"
printf 'root entry\n' > "$work/root-entry"
printf 'late non-root entry\n' > "$work/late-entry"
bsdtar -cf "$mixed_tar" --format=pax --uid 0 --gid 0 \
  -C "$work" root-entry
bsdtar -rf "$mixed_tar" --format=pax --uid 789 --gid 0 \
  -C "$work" late-entry
mixed_archive="$work/mixed.pkg.tar.zst"
zstd --quiet --force "$mixed_tar" -o "$mixed_archive"
assert_rejected "$mixed_archive" 'non-root ownership (789:0)'

duplicate_tar="$work/duplicate.tar"
printf 'first non-root copy\n' > "$work/duplicate-entry"
bsdtar -cf "$duplicate_tar" --format=pax --uid 654 --gid 0 \
  -C "$work" duplicate-entry
printf 'final root copy\n' > "$work/duplicate-entry"
bsdtar -rf "$duplicate_tar" --format=pax --uid 0 --gid 0 \
  -C "$work" duplicate-entry
duplicate_archive="$work/duplicate.pkg.tar.zst"
zstd --quiet --force "$duplicate_tar" -o "$duplicate_archive"
assert_rejected "$duplicate_archive" 'non-root ownership (654:0)'

symlink_tar="$work/symlink.tar"
ln -s root-entry "$work/nonroot-link"
bsdtar -cf "$symlink_tar" --format=pax --uid 0 --gid 0 \
  -C "$work" root-entry
bsdtar -rf "$symlink_tar" --format=pax --uid 0 --gid 321 \
  -C "$work" nonroot-link
symlink_archive="$work/nonroot-symlink.pkg.tar.zst"
zstd --quiet --force "$symlink_tar" -o "$symlink_archive"
assert_rejected "$symlink_archive" 'non-root ownership (0:321)'

empty_archive="$work/empty.pkg.tar.zst"
bsdtar -caf "$empty_archive" --format=pax -T /dev/null
assert_rejected "$empty_archive" 'package archive contains no entries'

invalid_archive="$work/invalid.pkg.tar.zst"
printf 'not an archive\n' > "$invalid_archive"
assert_rejected "$invalid_archive" 'could not inspect package archive metadata'

printf 'package archive ownership regression passed\n'
