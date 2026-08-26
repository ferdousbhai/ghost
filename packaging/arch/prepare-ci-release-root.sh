#!/usr/bin/bash

set -euo pipefail
export PATH=/usr/bin

(( EUID == 0 )) || {
  printf 'CI release-root preparation must run as root\n' >&2
  exit 1
}

builder="${1:?usage: prepare-ci-release-root.sh <builder-user>}"
[[ "$builder" =~ ^[a-z_][a-z0-9_-]*$ ]] || {
  printf 'invalid builder user: %s\n' "$builder" >&2
  exit 1
}
builder_uid="$(id -u "$builder")"
builder_gid="$(id -g "$builder")"
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
remove_source="$script_dir/remove-ci-release-root.sh"
seal_source="$script_dir/seal-ci-release-artifacts.py"
for source in "$remove_source" "$seal_source"; do
  [[ -f "$source" && ! -L "$source" ]] || {
    printf 'trusted CI root program is not a regular file: %s\n' "$source" >&2
    exit 1
  }
done

parent=/var/tmp
[[ -d "$parent" && ! -L "$parent" ]] || {
  printf 'trusted CI release parent is not a real directory: %s\n' "$parent" >&2
  exit 1
}
read -r parent_uid parent_mode parent_type < <(
  stat -Lc '%u %a %F' -- "$parent"
)
[[ "$parent_uid" == 0 && "$parent_type" == directory &&
  $(( 8#$parent_mode & 01000 )) -ne 0 ]] || {
  printf 'CI release parent must be root-owned and sticky: %s\n' "$parent" >&2
  exit 1
}

umask 077
outer="$(mktemp -d "$parent/ghost-ci-release.XXXXXXXXXX")"
remove_root_owned_anchor() {
  for child in out work sealed; do
    rmdir -- "$outer/$child" 2>/dev/null || true
  done
  unlink -- "$outer/remove-ci-release-root" 2>/dev/null || true
  unlink -- "$outer/seal-ci-release-artifacts.py" 2>/dev/null || true
  rmdir -- "$outer" 2>/dev/null || true
}
trap remove_root_owned_anchor EXIT

[[ -d "$outer" && ! -L "$outer" ]] || {
  printf 'mktemp did not create a real release directory\n' >&2
  exit 1
}
read -r outer_device outer_inode outer_owner outer_group outer_type < <(
  stat -Lc '%d %i %u %g %F' -- "$outer"
)
[[ "$outer_owner" == 0 && "$outer_group" == 0 &&
  "$outer_type" == directory ]] || {
  printf 'new CI release outer has unexpected identity\n' >&2
  exit 1
}

chmod 711 -- "$outer"
install -d -m700 -- "$outer/out" "$outer/work" "$outer/sealed"
install -m700 -o root -g root -- \
  "$remove_source" "$outer/remove-ci-release-root"
install -m700 -o root -g root -- \
  "$seal_source" "$outer/seal-ci-release-artifacts.py"

read -r out_device out_inode < <(stat -Lc '%d %i' -- "$outer/out")
read -r work_device work_inode < <(stat -Lc '%d %i' -- "$outer/work")
read -r sealed_device sealed_inode < <(stat -Lc '%d %i' -- "$outer/sealed")
chown --no-dereference "$builder_uid:$builder_gid" -- \
  "$outer/out" "$outer/work"

[[ -d "$outer" && ! -L "$outer" &&
  -d "$outer/out" && ! -L "$outer/out" &&
  -d "$outer/work" && ! -L "$outer/work" &&
  -d "$outer/sealed" && ! -L "$outer/sealed" ]] || {
  printf 'CI release anchor changed type during ownership transfer\n' >&2
  exit 1
}
[[ "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$outer")" == \
  "$outer_device:$outer_inode:0:0:711:directory" &&
  "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$outer/out")" == \
  "$out_device:$out_inode:$builder_uid:$builder_gid:700:directory" &&
  "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$outer/work")" == \
  "$work_device:$work_inode:$builder_uid:$builder_gid:700:directory" &&
  "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$outer/sealed")" == \
  "$sealed_device:$sealed_inode:0:0:700:directory" ]] || {
  printf 'CI release anchor changed identity during ownership transfer\n' >&2
  exit 1
}

trap - EXIT
printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
  "$outer" "$outer_device" "$outer_inode" \
  "$out_device" "$out_inode" "$work_device" "$work_inode" \
  "$sealed_device" "$sealed_inode"
