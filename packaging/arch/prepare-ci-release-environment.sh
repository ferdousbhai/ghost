#!/usr/bin/bash

set -euo pipefail
export PATH=/usr/bin

ghost_parse_release_identity() {
  local identity="${1-}"
  GHOST_CI_PARSED_RELEASE_IDENTITY=()

  [[ -n "$identity" && "$identity" != *$'\n'* &&
    "$identity" != *$'\r'* && "$identity" != $'\t'* &&
    "$identity" != *$'\t' && "$identity" != *$'\t\t'* ]] || return 1
  IFS=$'\t' read -r -a GHOST_CI_PARSED_RELEASE_IDENTITY <<< "$identity"
  [[ "${#GHOST_CI_PARSED_RELEASE_IDENTITY[@]}" -eq 9 ]] || return 1
  local field
  for field in "${GHOST_CI_PARSED_RELEASE_IDENTITY[@]}"; do
    [[ -n "$field" ]] || return 1
  done
  [[ "${GHOST_CI_PARSED_RELEASE_IDENTITY[0]}" == \
    /var/tmp/ghost-ci-release.* ]] || return 1
  for field in "${GHOST_CI_PARSED_RELEASE_IDENTITY[@]:1}"; do
    [[ "$field" =~ ^[0-9]+$ ]] || return 1
  done
}

ghost_prepare_release_environment() {
  (( EUID == 0 )) || {
    printf 'CI release environment preparation must run as root\n' >&2
    return 1
  }
  [[ "$#" -eq 3 ]] || {
    printf 'usage: prepare-ci-release-environment.sh <builder> <env-file> <workspace>\n' >&2
    return 2
  }

  local builder="$1"
  local env_file="$2"
  local workspace="$3"
  [[ -f "$env_file" && ! -L "$env_file" ]] || {
    printf 'Actions environment file is not a regular file: %s\n' \
      "$env_file" >&2
    return 1
  }
  [[ -d "$workspace" && ! -L "$workspace" ]] || {
    printf 'Actions workspace is not a real directory: %s\n' "$workspace" >&2
    return 1
  }

  local builder_uid builder_gid script_dir prepare identity
  builder_uid="$(/usr/bin/id -u "$builder")"
  builder_gid="$(/usr/bin/id -g "$builder")"
  script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
  prepare="$script_dir/prepare-ci-release-root.sh"
  identity="$(/usr/bin/bash "$prepare" "$builder")"
  ghost_parse_release_identity "$identity" || {
    printf 'CI release preparation returned malformed identity fields\n' >&2
    return 1
  }

  local outer="${GHOST_CI_PARSED_RELEASE_IDENTITY[0]}"
  local outer_device="${GHOST_CI_PARSED_RELEASE_IDENTITY[1]}"
  local outer_inode="${GHOST_CI_PARSED_RELEASE_IDENTITY[2]}"
  local out_device="${GHOST_CI_PARSED_RELEASE_IDENTITY[3]}"
  local out_inode="${GHOST_CI_PARSED_RELEASE_IDENTITY[4]}"
  local work_device="${GHOST_CI_PARSED_RELEASE_IDENTITY[5]}"
  local work_inode="${GHOST_CI_PARSED_RELEASE_IDENTITY[6]}"
  local sealed_device="${GHOST_CI_PARSED_RELEASE_IDENTITY[7]}"
  local sealed_inode="${GHOST_CI_PARSED_RELEASE_IDENTITY[8]}"

  /usr/bin/chown -R --no-dereference "$builder_uid:$builder_gid" "$workspace"
  /usr/bin/printf '%s\n' \
    "GHOST_CI_RELEASE_OUTER=$outer" \
    "GHOST_CI_RELEASE_OUT=$outer/out" \
    "GHOST_CI_RELEASE_WORK=$outer/work" \
    "GHOST_CI_RELEASE_SEALED=$outer/sealed" \
    "GHOST_CI_RELEASE_OUTER_DEVICE=$outer_device" \
    "GHOST_CI_RELEASE_OUTER_INODE=$outer_inode" \
    "GHOST_CI_RELEASE_OUT_DEVICE=$out_device" \
    "GHOST_CI_RELEASE_OUT_INODE=$out_inode" \
    "GHOST_CI_RELEASE_WORK_DEVICE=$work_device" \
    "GHOST_CI_RELEASE_WORK_INODE=$work_inode" \
    "GHOST_CI_RELEASE_SEALED_DEVICE=$sealed_device" \
    "GHOST_CI_RELEASE_SEALED_INODE=$sealed_inode" \
    >> "$env_file"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  ghost_prepare_release_environment "$@"
fi
