#!/usr/bin/bash

set -euo pipefail
export PATH=/usr/bin

(( EUID == 0 )) || {
  printf 'CI release outer removal must run as root\n' >&2
  exit 1
}

builder="${1:?missing builder}"
outer="${2:?missing release outer}"
outer_device="${3:?missing outer device}"
outer_inode="${4:?missing outer inode}"
out_device="${5:?missing out device}"
out_inode="${6:?missing out inode}"
work_device="${7:?missing work device}"
work_inode="${8:?missing work inode}"
sealed_device="${9:?missing sealed device}"
sealed_inode="${10:?missing sealed inode}"
builder_uid="$(id -u "$builder")"
builder_gid="$(id -g "$builder")"
out="$outer/out"
work="$outer/work"
sealed="$outer/sealed"
cleanup_program="$outer/remove-ci-release-root"
seal_program="$outer/seal-ci-release-artifacts.py"

[[ "$builder" =~ ^[a-z_][a-z0-9_-]*$ &&
  "$outer" == /var/tmp/ghost-ci-release.* &&
  "$outer_device" =~ ^[0-9]+$ && "$outer_inode" =~ ^[0-9]+$ &&
  "$out_device" =~ ^[0-9]+$ && "$out_inode" =~ ^[0-9]+$ &&
  "$work_device" =~ ^[0-9]+$ && "$work_inode" =~ ^[0-9]+$ &&
  "$sealed_device" =~ ^[0-9]+$ && "$sealed_inode" =~ ^[0-9]+$ &&
  -d "$outer" && ! -L "$outer" &&
  -d "$out" && ! -L "$out" && -d "$work" && ! -L "$work" &&
  -d "$sealed" && ! -L "$sealed" &&
  -f "$cleanup_program" && ! -L "$cleanup_program" &&
  -f "$seal_program" && ! -L "$seal_program" ]] || {
  printf 'refusing to remove an invalid CI release anchor\n' >&2
  exit 1
}
[[ "$(realpath -e -- "$outer")" == "$outer" &&
  "$(realpath -e -- "$0")" == "$cleanup_program" &&
  "$(stat -Lc '%u:%g:%a:%F' -- "$cleanup_program")" == \
    '0:0:700:regular file' &&
  "$(stat -Lc '%u:%g:%a:%F' -- "$seal_program")" == \
    '0:0:700:regular file' &&
  "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$outer")" == \
    "$outer_device:$outer_inode:0:0:711:directory" ]] || {
  printf 'refusing a redirected or changed CI release outer\n' >&2
  exit 1
}

validate_child() {
  local path="$1" device="$2" inode="$3" uid="$4" gid="$5"
  local actual_device actual_inode actual_uid actual_gid actual_type
  read -r actual_device actual_inode actual_uid actual_gid actual_type < <(
    stat -Lc '%d %i %u %g %F' -- "$path"
  )
  [[ "$actual_device" == "$device" && "$actual_inode" == "$inode" &&
    "$actual_uid" == "$uid" && "$actual_gid" == "$gid" &&
    "$actual_type" == directory ]]
}

validate_child "$out" "$out_device" "$out_inode" \
  "$builder_uid" "$builder_gid" || {
  printf 'refusing changed CI release out identity\n' >&2
  exit 1
}
validate_child "$work" "$work_device" "$work_inode" \
  "$builder_uid" "$builder_gid" || {
  printf 'refusing changed CI release work identity\n' >&2
  exit 1
}
validate_child "$sealed" "$sealed_device" "$sealed_inode" 0 0 || {
  printf 'refusing changed sealed upload identity\n' >&2
  exit 1
}

for child in "$out" "$work" "$sealed"; do
  find -P "$child" -xdev -mindepth 1 -depth -delete
done
validate_child "$out" "$out_device" "$out_inode" \
  "$builder_uid" "$builder_gid"
validate_child "$work" "$work_device" "$work_inode" \
  "$builder_uid" "$builder_gid"
validate_child "$sealed" "$sealed_device" "$sealed_inode" 0 0
rmdir -- "$out" "$work" "$sealed"
[[ "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$outer")" == \
  "$outer_device:$outer_inode:0:0:711:directory" ]] || {
  printf 'CI release outer changed before final removal\n' >&2
  exit 1
}
unlink -- "$seal_program"
unlink -- "$cleanup_program"
rmdir -- "$outer"
