#!/usr/bin/bash

ghost_ci_validate_release_paths() {
  local outer="${GHOST_CI_RELEASE_OUTER:?release outer is required}"
  local out="${GHOST_CI_RELEASE_OUT:?release out is required}"
  local work="${GHOST_CI_RELEASE_WORK:?release work is required}"
  local outer_device="${GHOST_CI_RELEASE_OUTER_DEVICE:?outer device is required}"
  local outer_inode="${GHOST_CI_RELEASE_OUTER_INODE:?outer inode is required}"
  local out_device="${GHOST_CI_RELEASE_OUT_DEVICE:?out device is required}"
  local out_inode="${GHOST_CI_RELEASE_OUT_INODE:?out inode is required}"
  local work_device="${GHOST_CI_RELEASE_WORK_DEVICE:?work device is required}"
  local work_inode="${GHOST_CI_RELEASE_WORK_INODE:?work inode is required}"

  [[ "$outer" == /var/tmp/ghost-ci-release.* &&
    "$out" == "$outer/out" && "$work" == "$outer/work" &&
    "$outer_device" =~ ^[0-9]+$ && "$outer_inode" =~ ^[0-9]+$ &&
    "$out_device" =~ ^[0-9]+$ && "$out_inode" =~ ^[0-9]+$ &&
    "$work_device" =~ ^[0-9]+$ && "$work_inode" =~ ^[0-9]+$ &&
    -d "$outer" && ! -L "$outer" &&
    -d "$out" && ! -L "$out" && -d "$work" && ! -L "$work" ]] || {
    printf 'invalid CI release path or identity input\n' >&2
    return 1
  }
  [[ "$(realpath -e -- "$outer")" == "$outer" &&
    "$(realpath -e -- "$out")" == "$out" &&
    "$(realpath -e -- "$work")" == "$work" &&
    "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$outer")" == \
      "$outer_device:$outer_inode:0:0:711:directory" &&
    "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$out")" == \
      "$out_device:$out_inode:$EUID:$(id -g):700:directory" &&
    "$(stat -Lc '%d:%i:%u:%g:%a:%F' -- "$work")" == \
      "$work_device:$work_inode:$EUID:$(id -g):700:directory" ]] || {
    printf 'CI release directory identity changed\n' >&2
    return 1
  }
}
