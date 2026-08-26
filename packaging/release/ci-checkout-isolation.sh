#!/usr/bin/bash

# NUL-safe, same-filesystem checkout relocation used by package archive smoke.

ghost_ci_path_exists() {
  [[ -e "$1" || -L "$1" ]]
}

ghost_ci_isolation_path() {
  printf '%s/.ghost-ci-hidden-checkout\n' "$1"
}

ghost_ci_validate_isolation_state() {
  local workspace="$1"
  local hidden payload manifest normalized state_list name
  hidden="$(ghost_ci_isolation_path "$workspace")"
  payload="$hidden/payload"
  manifest="$hidden/manifest"
  normalized="$hidden/.manifest-normalized"
  state_list="$hidden/.state-list"

  [[ -d "$workspace" && ! -L "$workspace" &&
    -d "$hidden" && ! -L "$hidden" &&
    -d "$payload" && ! -L "$payload" &&
    -f "$manifest" && ! -L "$manifest" ]] || {
    printf 'checkout isolation state changed type\n' >&2
    return 1
  }

  if ! LC_ALL=C /usr/bin/sort -z -u -- "$manifest" > "$normalized"; then
    return 1
  fi
  if ! /usr/bin/cmp -s -- "$manifest" "$normalized"; then
    printf 'checkout isolation manifest is not sorted and unique\n' >&2
    /usr/bin/rm -f -- "$normalized"
    return 1
  fi
  while IFS= read -r -d '' name; do
    [[ -n "$name" && "$name" != . && "$name" != .. &&
      "$name" != */* ]] || {
      printf 'checkout isolation manifest is invalid\n' >&2
      /usr/bin/rm -f -- "$normalized"
      return 1
    }
  done < "$manifest"
  [[ -s "$manifest" ]] || {
    printf 'checkout isolation manifest is empty\n' >&2
    /usr/bin/rm -f -- "$normalized"
    return 1
  }
  if ! {
    /usr/bin/find -P "$workspace" -mindepth 1 -maxdepth 1 \
      ! -path "$hidden" -printf '%f\0' &&
    /usr/bin/find -P "$payload" -mindepth 1 -maxdepth 1 -printf '%f\0'
  } | LC_ALL=C /usr/bin/sort -z > "$state_list"; then
    /usr/bin/rm -f -- "$normalized" "$state_list"
    return 1
  fi
  if ! /usr/bin/cmp -s -- "$manifest" "$state_list"; then
    printf 'checkout entries do not match the relocation manifest\n' >&2
    /usr/bin/rm -f -- "$normalized" "$state_list"
    return 1
  fi
  /usr/bin/rm -- "$normalized" "$state_list" || return 1
}

ghost_ci_hide_checkout() {
  local workspace="$1"
  local hidden payload manifest name count fail_after
  GHOST_CI_ISOLATION_CREATED=0
  hidden="$(ghost_ci_isolation_path "$workspace")"
  payload="$hidden/payload"
  manifest="$hidden/manifest"

  [[ "$workspace" == /* && -d "$workspace" && ! -L "$workspace" ]] || {
    printf 'checkout workspace is not a real absolute directory: %s\n' \
      "$workspace" >&2
    return 1
  }
  if ghost_ci_path_exists "$hidden"; then
    printf 'checkout isolation state already exists: %s\n' "$hidden" >&2
    return 1
  fi

  GHOST_CI_ISOLATION_CREATED=1
  if ! (umask 077 && /usr/bin/mkdir -- "$hidden"); then
    GHOST_CI_ISOLATION_CREATED=0
    return 1
  fi
  /usr/bin/mkdir -m700 -- "$payload" || return 1
  local manifest_tmp="$hidden/manifest.tmp"
  if ! /usr/bin/find -P "$workspace" -mindepth 1 -maxdepth 1 \
      ! -path "$hidden" -printf '%f\0' | LC_ALL=C /usr/bin/sort -z \
        > "$manifest_tmp"; then
    return 1
  fi
  /usr/bin/chmod 600 -- "$manifest_tmp" || return 1
  /usr/bin/mv -T --no-clobber -- "$manifest_tmp" "$manifest" || return 1
  [[ ! -e "$manifest_tmp" && -f "$manifest" && ! -L "$manifest" ]] || \
    return 1
  [[ -s "$manifest" ]] || {
    printf 'refusing to isolate an empty checkout\n' >&2
    /usr/bin/rm -- "$manifest" || return 1
    /usr/bin/rmdir -- "$payload" || return 1
    /usr/bin/rmdir -- "$hidden" || return 1
    GHOST_CI_ISOLATION_CREATED=0
    return 1
  }

  count=0
  fail_after="${GHOST_CI_ISOLATION_FAIL_HIDE_AFTER:-0}"
  [[ "$fail_after" =~ ^[0-9]+$ ]] || return 1
  local workspace_device
  workspace_device="$(/usr/bin/stat -c '%d' -- "$workspace")" || return 1
  while IFS= read -r -d '' name; do
    ghost_ci_path_exists "$workspace/$name" || {
      printf 'checkout entry disappeared before relocation: %q\n' "$name" >&2
      return 1
    }
    ! ghost_ci_path_exists "$payload/$name" || {
      printf 'checkout isolation destination already exists: %q\n' "$name" >&2
      return 1
    }
    [[ "$(/usr/bin/stat -c '%d' -- "$workspace/$name")" == \
      "$workspace_device" ]] || {
      printf 'checkout entry is not on the workspace filesystem: %q\n' \
        "$name" >&2
      return 1
    }
    /usr/bin/mv -T --no-clobber -- \
      "$workspace/$name" "$payload/$name" || return 1
    ! ghost_ci_path_exists "$workspace/$name" &&
      ghost_ci_path_exists "$payload/$name" || return 1
    count=$(( count + 1 ))
    if (( fail_after > 0 && count == fail_after )); then
      printf 'injected checkout hide failure after %s entries\n' "$count" >&2
      return 1
    fi
  done < "$manifest"
  ghost_ci_validate_isolation_state "$workspace"
  [[ -z "$(/usr/bin/find -P "$workspace" -mindepth 1 -maxdepth 1 \
    ! -path "$hidden" -print -quit)" ]] || return 1
  : > "$hidden/hidden-complete" || return 1
}

ghost_ci_restore_checkout() {
  local workspace="$1"
  local hidden payload manifest manifest_tmp name count fail_after injected
  hidden="$(ghost_ci_isolation_path "$workspace")"
  payload="$hidden/payload"
  manifest="$hidden/manifest"
  manifest_tmp="$hidden/manifest.tmp"

  if ! ghost_ci_path_exists "$hidden"; then
    GHOST_CI_ISOLATION_CREATED=0
    return 0
  fi
  [[ -d "$hidden" && ! -L "$hidden" ]] || {
    printf 'checkout isolation root changed type during restore\n' >&2
    return 1
  }

  # Signals before the manifest is atomically published cannot interrupt a
  # source move. Remove only the known empty bootstrap state in that phase.
  if ! ghost_ci_path_exists "$manifest"; then
    if ghost_ci_path_exists "$payload"; then
      [[ -d "$payload" && ! -L "$payload" &&
        -z "$(/usr/bin/find -P "$payload" -mindepth 1 -print -quit)" ]] || {
        printf 'unmanifested checkout isolation payload is not empty\n' >&2
        return 1
      }
    fi
    if ghost_ci_path_exists "$manifest_tmp"; then
      [[ -f "$manifest_tmp" && ! -L "$manifest_tmp" ]] || {
        printf 'checkout isolation temporary manifest changed type\n' >&2
        return 1
      }
      /usr/bin/rm -- "$manifest_tmp" || return 1
    fi
    if ghost_ci_path_exists "$payload"; then
      /usr/bin/rmdir -- "$payload" || return 1
    fi
    [[ -z "$(/usr/bin/find -P "$hidden" -mindepth 1 -print -quit)" ]] || {
      printf 'unexpected pre-manifest checkout isolation state\n' >&2
      return 1
    }
    /usr/bin/rmdir -- "$hidden" || return 1
    GHOST_CI_ISOLATION_CREATED=0
    return 0
  fi

  ghost_ci_validate_isolation_state "$workspace" || return 1
  count=0
  fail_after="${GHOST_CI_ISOLATION_FAIL_RESTORE_AFTER:-0}"
  [[ "$fail_after" =~ ^[0-9]+$ ]] || return 1
  injected="$hidden/.restore-failure-injected"
  while IFS= read -r -d '' name; do
    if ghost_ci_path_exists "$payload/$name"; then
      ! ghost_ci_path_exists "$workspace/$name" || {
        printf 'refusing to clobber restored checkout entry: %q\n' "$name" >&2
        return 1
      }
      /usr/bin/mv -T --no-clobber -- \
        "$payload/$name" "$workspace/$name" || return 1
      ! ghost_ci_path_exists "$payload/$name" &&
        ghost_ci_path_exists "$workspace/$name" || return 1
      count=$(( count + 1 ))
      if (( fail_after > 0 && count == fail_after )) && \
          ! ghost_ci_path_exists "$injected"; then
        : > "$injected" || return 1
        printf 'injected checkout restore failure after %s entries\n' \
          "$count" >&2
        return 1
      fi
    fi
  done < "$manifest"

  ghost_ci_validate_isolation_state "$workspace"
  [[ -z "$(/usr/bin/find -P "$payload" -mindepth 1 -maxdepth 1 \
    -print -quit)" ]] || {
      printf 'checkout isolation payload is not empty after restore\n' >&2
      return 1
    }
  /usr/bin/rm -f -- "$hidden/hidden-complete" "$injected" || return 1
  /usr/bin/rm -- "$manifest" || return 1
  /usr/bin/rmdir -- "$payload" || return 1
  /usr/bin/rmdir -- "$hidden" || return 1
  GHOST_CI_ISOLATION_CREATED=0
}
