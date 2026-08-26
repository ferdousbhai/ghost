#!/usr/bin/env bash

set -euo pipefail

(( EUID == 0 )) || {
  printf 'release checksum regression must run as root\n' >&2
  exit 1
}
builder="${1:?usage: test-release-checksums.sh <builder-user>}"
[[ "$builder" =~ ^[a-z_][a-z0-9_-]*$ ]]
builder_group="$(id -gn "$builder")"
builder_command=(
  /usr/bin/runuser -u "$builder" -- /usr/bin/env -i
  HOME=/home/builder PATH=/usr/bin TMPDIR=/home/builder
)

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
checksum_writer="$(realpath "$script_dir/../release/write-sha256sums.sh")"
temp_base="${GHOST_RELEASE_CHECKSUM_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-release-checksums.XXXXXX")"
cleanup() {
  chmod -R u+rwx "$work" 2>/dev/null || true
  find -P "$work" -depth -delete
}
trap cleanup EXIT
chmod 755 "$work"

release_dir="$work/release output with spaces"
install -d -m755 -o "$builder" -g "$builder_group" "$release_dir"
"${builder_command[@]}" bash -c \
  'printf b > "$1/b artifact"; printf a > "$1/a artifact"' _ "$release_dir"
"${builder_command[@]}" bash "$checksum_writer" "$release_dir"
mapfile -t sums < "$release_dir/SHA256SUMS"
[[ "${#sums[@]}" -eq 2 ]]
[[ "${sums[0]}" == *'  a artifact' && "${sums[1]}" == *'  b artifact' ]]
[[ "$(stat -c '%U:%G' "$release_dir/SHA256SUMS")" == \
  "$builder:$builder_group" ]]
[[ "$(stat -c '%a' "$release_dir/SHA256SUMS")" == 644 ]]

wrong_cwd="$work/wrong working directory"
install -d -m755 -o "$builder" -g "$builder_group" "$wrong_cwd"
printf 'preserve\n' > "$wrong_cwd/SHA256SUMS"
chown "$builder:$builder_group" "$wrong_cwd/SHA256SUMS"
if "${builder_command[@]}" bash -c \
    'cd -- "$1"; bash "$2" "$3"' _ \
    "$wrong_cwd" "$checksum_writer" "$work/missing output"; then
  printf 'checksum writer accepted a missing target\n' >&2
  exit 1
fi
grep -Fxq preserve "$wrong_cwd/SHA256SUMS"

find_failure="$work/find failure"
install -d -m300 -o "$builder" -g "$builder_group" "$find_failure"
printf 'preserve\n' > "$find_failure/SHA256SUMS"
chown "$builder:$builder_group" "$find_failure/SHA256SUMS"
if "${builder_command[@]}" bash "$checksum_writer" "$find_failure"; then
  printf 'checksum writer ignored a find failure\n' >&2
  exit 1
fi
grep -Fxq preserve "$find_failure/SHA256SUMS"

sort_failure="$work/sort failure"
fake_bin="$work/failing tools"
install -d -m755 -o "$builder" -g "$builder_group" \
  "$sort_failure" "$fake_bin"
"${builder_command[@]}" bash -c \
  'printf artifact > "$1/artifact"; printf preserve > "$1/SHA256SUMS"' \
  _ "$sort_failure"
printf '#!/usr/bin/env bash\nexit 42\n' > "$fake_bin/sort"
chmod 755 "$fake_bin/sort"
if "${builder_command[@]}" PATH="$fake_bin:/usr/bin" \
    bash "$checksum_writer" "$sort_failure"; then
  printf 'checksum writer ignored a sort failure\n' >&2
  exit 1
fi
grep -Fxq preserve "$sort_failure/SHA256SUMS"

for directory in "$wrong_cwd" "$find_failure" "$sort_failure"; do
  if find "$directory" -maxdepth 1 -name '.SHA256SUMS.*' \
      -print -quit | grep -q .; then
    printf 'checksum writer left a partial file in %s\n' "$directory" >&2
    exit 1
  fi
done

printf 'stable release checksum failure handling passed\n'
