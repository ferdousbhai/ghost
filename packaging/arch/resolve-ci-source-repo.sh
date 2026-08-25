#!/usr/bin/env bash

# GitHub's `github.workspace` expression is evaluated on the runner host, while
# a container job sees the checkout through its own mount path. Resolve the
# package source from the runtime environment inside the container and prove
# that the resulting file URL exposes exactly the checked-out commit.

set -euo pipefail

expected_commit="${1:?usage: resolve-ci-source-repo.sh <expected-commit>}"
workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"

[[ "$expected_commit" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'invalid expected source commit: %s\n' "$expected_commit" >&2
  exit 1
}

workspace="$(realpath -e -- "$workspace")"
source_root="$(git -c safe.directory="$workspace" -C "$workspace" \
  rev-parse --show-toplevel)"
source_root="$(realpath -e -- "$source_root")"
if [[ "$source_root" != "$workspace" ]]; then
  printf 'GITHUB_WORKSPACE %s is not the repository root %s\n' \
    "$workspace" "$source_root" >&2
  exit 1
fi

source_commit="$(git -c safe.directory="$source_root" -C "$source_root" \
  rev-parse 'HEAD^{commit}')"
if [[ "$source_commit" != "$expected_commit" ]]; then
  printf 'container checkout commit %s does not match expected %s\n' \
    "$source_commit" "$expected_commit" >&2
  exit 1
fi

source_repo="file://$source_root"
remote_commit="$(git -c safe.directory="$source_root" ls-remote "$source_repo" HEAD \
  | awk 'NR == 1 { print $1 }')"
if [[ "$remote_commit" != "$source_commit" ]]; then
  printf 'container-local source %s resolves to %s, not %s\n' \
    "$source_repo" "${remote_commit:-nothing}" "$source_commit" >&2
  exit 1
fi

printf '%s\n' "$source_repo"
