#!/usr/bin/bash

set -euo pipefail
export PATH=/usr/bin

(( EUID == 0 )) || {
  printf 'CI release-root regression must run as root\n' >&2
  exit 1
}

builder="${1:?usage: test-ci-release-root.sh <builder-user>}"
builder_group="$(id -gn "$builder")"
builder_command=(
  /usr/bin/runuser -u "$builder" -- /usr/bin/env -i
  HOME=/home/builder PATH=/usr/bin TMPDIR=/home/builder
)
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
prepare_environment="$script_dir/prepare-ci-release-environment.sh"
checksum_writer="$(realpath "$script_dir/../release/write-sha256sums.sh")"
stable_build="$(realpath "$script_dir/../release/ci-build-stable.sh")"
archive_verify="$(realpath \
  "$script_dir/../release/ci-verify-package-archives.sh")"
archive_owner_test="$(realpath \
  "$script_dir/../release/test-package-archive-ownership.sh")"
archive_owner_verify="$(realpath \
  "$script_dir/../release/verify-package-archive-ownership.sh")"
path_validator="$(realpath "$script_dir/../release/ci-release-paths.sh")"
isolation_test="$(realpath \
  "$script_dir/../release/test-checkout-isolation.sh")"
workflow="$(realpath "$script_dir/../../.github/workflows/arch-package.yml")"

grep -Fq '${{ env.GHOST_CI_RELEASE_SEALED }}/' "$workflow"
! grep -Eq 'packaging/release/(out|work)' "$workflow"

test_parent="$(mktemp -d /var/tmp/ghost-ci-release-test.XXXXXXXXXX)"
outer=""
remove_test_state() {
  if [[ "$outer" == /var/tmp/ghost-ci-release.* &&
    -d "$outer" && ! -L "$outer" ]]; then
    for child in out work sealed; do
      if [[ -d "$outer/$child" && ! -L "$outer/$child" ]]; then
        chmod 700 -- "$outer/$child" 2>/dev/null || true
        find -P "$outer/$child" -xdev -mindepth 1 -depth -delete \
          2>/dev/null || true
        rmdir -- "$outer/$child" 2>/dev/null || true
      fi
    done
    unlink -- "$outer/remove-ci-release-root" 2>/dev/null || true
    unlink -- "$outer/seal-ci-release-artifacts.py" 2>/dev/null || true
    rmdir -- "$outer" 2>/dev/null || true
  fi
  find -P "$test_parent" -depth -delete
}
trap remove_test_state EXIT

checkout="$test_parent/checkout"
outside="$test_parent/outside sentinel"
mkdir -p -- "$checkout/packaging/release" "$outside"
printf 'must remain unchanged\n' > "$outside/sentinel"
ln -s -- "$outside" "$checkout/packaging/release/out"
ln -s -- "$outside" "$checkout/packaging/release/work"
outside_identity="$(stat -Lc '%u:%g:%a:%d:%i' -- "$outside")"
outside_hash="$(sha256sum "$outside/sentinel")"

source "$prepare_environment"
for malformed_identity in \
  $'/var/tmp/ghost-ci-release.fixture\t1\t2\t3\t4\t5\t6\t7' \
  $'/var/tmp/ghost-ci-release.fixture\t1\t2\t3\t4\t5\t6\t7\t8\t9' \
  $'/var/tmp/ghost-ci-release.fixture\t1\t2\t3\t4\t\t6\t7\t8' \
  $'/var/tmp/ghost-ci-release.fixture\t1\t2\t3\t4\t+\t6\t7\t8' \
  $'/var/tmp/ghost-ci-release.fixture\t1\t2\t3\t4\t5\t6\t7\t8\nextra'; do
  if ghost_parse_release_identity "$malformed_identity"; then
    printf 'release identity parser accepted malformed fields: %q\n' \
      "$malformed_identity" >&2
    exit 1
  fi
done

github_env="$test_parent/github env"
: > "$github_env"
/usr/bin/env -i HOME=/root PATH=/usr/bin TMPDIR=/var/tmp \
  /usr/bin/bash "$prepare_environment" "$builder" "$github_env" "$checkout"
mapfile -t release_lines < "$github_env"
[[ "${#release_lines[@]}" -eq 12 ]]
[[ "${release_lines[0]}" == GHOST_CI_RELEASE_OUTER=* ]]
[[ "${release_lines[4]}" == GHOST_CI_RELEASE_OUTER_DEVICE=* ]]
[[ "${release_lines[5]}" == GHOST_CI_RELEASE_OUTER_INODE=* ]]
[[ "${release_lines[6]}" == GHOST_CI_RELEASE_OUT_DEVICE=* ]]
[[ "${release_lines[7]}" == GHOST_CI_RELEASE_OUT_INODE=* ]]
[[ "${release_lines[8]}" == GHOST_CI_RELEASE_WORK_DEVICE=* ]]
[[ "${release_lines[9]}" == GHOST_CI_RELEASE_WORK_INODE=* ]]
[[ "${release_lines[10]}" == GHOST_CI_RELEASE_SEALED_DEVICE=* ]]
[[ "${release_lines[11]}" == GHOST_CI_RELEASE_SEALED_INODE=* ]]
outer="${release_lines[0]#*=}"
outer_device="${release_lines[4]#*=}"
outer_inode="${release_lines[5]#*=}"
out_device="${release_lines[6]#*=}"
out_inode="${release_lines[7]#*=}"
work_device="${release_lines[8]#*=}"
work_inode="${release_lines[9]#*=}"
sealed_device="${release_lines[10]#*=}"
sealed_inode="${release_lines[11]#*=}"
out="$outer/out"
work="$outer/work"
sealed="$outer/sealed"
sealer="$outer/seal-ci-release-artifacts.py"
remover="$outer/remove-ci-release-root"
expected_release_lines=(
  "GHOST_CI_RELEASE_OUTER=$outer"
  "GHOST_CI_RELEASE_OUT=$out"
  "GHOST_CI_RELEASE_WORK=$work"
  "GHOST_CI_RELEASE_SEALED=$sealed"
  "GHOST_CI_RELEASE_OUTER_DEVICE=$outer_device"
  "GHOST_CI_RELEASE_OUTER_INODE=$outer_inode"
  "GHOST_CI_RELEASE_OUT_DEVICE=$out_device"
  "GHOST_CI_RELEASE_OUT_INODE=$out_inode"
  "GHOST_CI_RELEASE_WORK_DEVICE=$work_device"
  "GHOST_CI_RELEASE_WORK_INODE=$work_inode"
  "GHOST_CI_RELEASE_SEALED_DEVICE=$sealed_device"
  "GHOST_CI_RELEASE_SEALED_INODE=$sealed_inode"
)
for index in "${!expected_release_lines[@]}"; do
  [[ "${release_lines[index]}" == "${expected_release_lines[index]}" ]]
done

[[ "$(stat -Lc '%u:%g:%a:%d:%i' -- "$outer")" == \
  "0:0:711:$outer_device:$outer_inode" ]]
[[ "$(stat -Lc '%U:%G:%a:%d:%i' -- "$out")" == \
  "$builder:$builder_group:700:$out_device:$out_inode" ]]
[[ "$(stat -Lc '%U:%G:%a:%d:%i' -- "$work")" == \
  "$builder:$builder_group:700:$work_device:$work_inode" ]]
[[ "$(stat -Lc '%u:%g:%a:%d:%i' -- "$sealed")" == \
  "0:0:700:$sealed_device:$sealed_inode" ]]
[[ "$(stat -Lc '%U:%G' -- "$checkout")" == "$builder:$builder_group" ]]

release_env=(
  "GHOST_CI_RELEASE_OUTER=$outer"
  "GHOST_CI_RELEASE_OUT=$out"
  "GHOST_CI_RELEASE_WORK=$work"
  "GHOST_CI_RELEASE_OUTER_DEVICE=$outer_device"
  "GHOST_CI_RELEASE_OUTER_INODE=$outer_inode"
  "GHOST_CI_RELEASE_OUT_DEVICE=$out_device"
  "GHOST_CI_RELEASE_OUT_INODE=$out_inode"
  "GHOST_CI_RELEASE_WORK_DEVICE=$work_device"
  "GHOST_CI_RELEASE_WORK_INODE=$work_inode"
)
if /usr/bin/bash "$stable_build"; then
  printf 'stable build accepted a root caller\n' >&2
  exit 1
fi
if /usr/bin/bash "$archive_verify"; then
  printf 'archive verification accepted a root caller\n' >&2
  exit 1
fi
if /usr/bin/bash "$archive_owner_verify" "$outside/sentinel"; then
  printf 'archive ownership verification accepted a root caller\n' >&2
  exit 1
fi
"${builder_command[@]}" /usr/bin/bash "$archive_owner_test"
"${builder_command[@]}" "${release_env[@]}" /usr/bin/bash -c \
  'source "$1"; ghost_ci_validate_release_paths' _ "$path_validator"

# The production prepare-step transfer must not redirect root ownership changes
# through tracked out/work symlinks into the outside sentinel.
[[ "$(stat -Lc '%u:%g:%a:%d:%i' -- "$outside")" == "$outside_identity" ]]

# Fixed children cannot be renamed, recreated, or replaced by builder code.
for child in out work; do
  if "${builder_command[@]}" mv -- "$outer/$child" "$outer/$child.moved"; then
    printf 'builder moved fixed %s entry\n' "$child" >&2
    exit 1
  fi
  if "${builder_command[@]}" ln -s -- "$outside" "$outer/$child.swap"; then
    printf 'builder created sibling replacement for %s\n' "$child" >&2
    exit 1
  fi
done
if "${builder_command[@]}" ls -- "$sealed" >/dev/null 2>&1; then
  printf 'builder accessed root-only sealed upload directory\n' >&2
  exit 1
fi

# Minimal builder execution must discard every Actions command-file hook and
# poisoned shell environment while resolving tools only from trusted PATH.
poison="$test_parent/poison"
mkdir -- "$poison"
printf 'exit 91\n' > "$poison/BASH_ENV"
chmod 755 "$poison/BASH_ENV"
/usr/bin/runuser -u "$builder" -- /usr/bin/env \
  GITHUB_ENV="$outside/sentinel" \
  GITHUB_OUTPUT="$outside/sentinel" \
  GITHUB_PATH="$outside/sentinel" \
  GITHUB_STATE="$outside/sentinel" \
  GITHUB_STEP_SUMMARY="$outside/sentinel" \
  BASH_ENV="$poison/BASH_ENV" ENV="$poison/BASH_ENV" \
  PATH="$poison:/usr/bin" \
  /usr/bin/env -i HOME=/home/builder PATH=/usr/bin TMPDIR=/home/builder \
    /usr/bin/bash -c '
      set -euo pipefail
      for name in GITHUB_ENV GITHUB_OUTPUT GITHUB_PATH GITHUB_STATE \
        GITHUB_STEP_SUMMARY BASH_ENV ENV; do
        [[ ! -v "$name" ]]
      done
      [[ "$(command -v git)" == /usr/bin/git ]]
    '

artifact_names=(
  ghost-0.0.1.tar.gz
  ghost-runtime-0.0.1-linux-x86_64.tar.zst
  ghost-runtime-0.0.1-linux-x86_64.tar.zst.sha256
  ghost-ai-0.0.1-aur.tar.zst
  ghost-ai-0.0.1-1-x86_64.pkg.tar.zst
  ghost-ai-git-0.0.1-1-x86_64.pkg.tar.zst
)
"${builder_command[@]}" \
  /usr/bin/bash -c '
    set -euo pipefail
    out="$1"; shift
    for name in "$@"; do printf "%s\n" "$name" > "$out/$name"; done
  ' _ "$out" "${artifact_names[@]}"
"${builder_command[@]}" \
  /usr/bin/bash "$checksum_writer" "$out"

seal_args=(
  "$builder" "$outer" "$outer_device" "$outer_inode"
  "$out_device" "$out_inode" "$sealed_device" "$sealed_inode"
)
if /usr/bin/python "$sealer" "${seal_args[@]:0:5}" \
    "$(( out_inode + 1 ))" "${seal_args[@]:6}"; then
  printf 'sealer accepted a mismatched out inode\n' >&2
  exit 1
fi

# A package-looking symlink is never accepted as an artifact.
"${builder_command[@]}" ln -s -- "$outside/sentinel" \
  "$out/ghost-ai-bad-x86_64.pkg.tar.zst"
if /usr/bin/python "$sealer" "${seal_args[@]}"; then
  printf 'sealer accepted a symlinked release artifact\n' >&2
  exit 1
fi
"${builder_command[@]}" unlink -- \
  "$out/ghost-ai-bad-x86_64.pkg.tar.zst"

# Deterministically mutate an already-open source fd. Sealing must fail and
# leave the root-only destination empty, never publish a torn snapshot.
target="${artifact_names[0]}"
ready="$work/seal-ready"
proceed="$work/seal-continue"
"${builder_command[@]}" /usr/bin/bash -c '
  set -euo pipefail
  exec 9>> "$1"
  while [[ ! -e "$2" ]]; do /usr/bin/sleep 0.01; done
  printf mutation >&9
  : > "$3"
' _ "$out/$target" "$ready" "$proceed" &
mutator=$!
if GHOST_CI_SEAL_TEST_TARGET="$target" \
    GHOST_CI_SEAL_TEST_READY="$ready" \
    GHOST_CI_SEAL_TEST_CONTINUE="$proceed" \
    /usr/bin/python "$sealer" "${seal_args[@]}"; then
  printf 'sealer accepted an open-fd artifact mutation\n' >&2
  exit 1
fi
wait "$mutator"
[[ -z "$(find "$sealed" -mindepth 1 -print -quit)" ]]

# Refresh the manifest for the now-stable source and seal exactly once.
"${builder_command[@]}" \
  /usr/bin/bash "$checksum_writer" "$out"
/usr/bin/env -i HOME=/root PATH=/usr/bin TMPDIR=/var/tmp \
  /usr/bin/python "$sealer" "${seal_args[@]}"
[[ "$(stat -Lc '%u:%g:%a:%d:%i' -- "$sealed")" == \
  "0:0:500:$sealed_device:$sealed_inode" ]]
sealed_hash="$(sha256sum "$sealed/$target")"
"${builder_command[@]}" /usr/bin/bash -c \
  'printf late-change >> "$1"' _ "$out/$target"
[[ "$(sha256sum "$sealed/$target")" == "$sealed_hash" ]]
if "${builder_command[@]}" ls -- "$sealed" >/dev/null 2>&1; then
  printf 'builder accessed sealed upload after publication\n' >&2
  exit 1
fi

remove_args=(
  "$builder" "$outer" "$outer_device" "$outer_inode"
  "$out_device" "$out_inode" "$work_device" "$work_inode"
  "$sealed_device" "$sealed_inode"
)
if /usr/bin/bash "$remover" "${remove_args[@]:0:6}" \
    "$(( work_inode + 1 ))" "${remove_args[@]:7}"; then
  printf 'root remover accepted a mismatched work inode\n' >&2
  exit 1
fi

# Cleanup tolerates builder dirt/modes but remains non-following.
"${builder_command[@]}" /usr/bin/bash -c '
  chmod 755 -- "$1" "$2"
  printf dirty > "$1/late-dirt"
  ln -s -- "$3" "$2/outside-link"
' _ "$out" "$work" "$outside"
/usr/bin/env -i HOME=/root PATH=/usr/bin TMPDIR=/var/tmp \
  /usr/bin/bash "$remover" "${remove_args[@]}"
[[ ! -e "$outer" && ! -L "$outer" ]]
outer=""
[[ "$(stat -Lc '%u:%g:%a:%d:%i' -- "$outside")" == "$outside_identity" ]]
[[ "$(sha256sum "$outside/sentinel")" == "$outside_hash" ]]
"${builder_command[@]}" GHOST_CI_ISOLATION_TEST_ROOT=/home/builder \
  /usr/bin/bash "$isolation_test"
printf 'trusted CI release-root and sealed-upload isolation passed\n'
