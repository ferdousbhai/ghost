#!/usr/bin/env bash

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
resolver="$script_dir/resolve-ci-source-repo.sh"
temp_base="${GHOST_CI_SOURCE_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
fixture="$(mktemp -d "$temp_base/ghost-ci-source.XXXXXX")"
cleanup() {
  find -P "$fixture" -depth -delete
}
trap cleanup EXIT

# Model the same checkout at an arbitrary container mount. A poisoned value for
# the old host-only override must not influence runtime source resolution.
workspace="$fixture/__w/arbitrary owner/arbitrary repository"
mkdir -p "$workspace"
git -C "$workspace" init --quiet
printf 'container-local fixture\n' > "$workspace/README"
git -C "$workspace" add README
git -C "$workspace" \
  -c user.name='Ghost packaging test' \
  -c user.email='packaging-test@localhost' \
  commit --quiet -m fixture
commit="$(git -C "$workspace" rev-parse 'HEAD^{commit}')"

actual="$(env \
  GITHUB_WORKSPACE="$workspace" \
  GHOST_SOURCE_REPO='file:///home/runner/work/wrong-owner/wrong-repo' \
  bash "$resolver" "$commit")"
expected="file://$(realpath -e -- "$workspace")"
if [[ "$actual" != "$expected" ]]; then
  printf 'container source URL mismatch: got %s, expected %s\n' \
    "$actual" "$expected" >&2
  exit 1
fi
resolved_commit="$(git ls-remote "$actual" HEAD | awk 'NR == 1 { print $1 }')"
[[ "$resolved_commit" == "$commit" ]] || {
  printf 'resolved source commit %s does not match fixture %s\n' \
    "$resolved_commit" "$commit" >&2
  exit 1
}

wrong_commit="0000000000000000000000000000000000000000"
if env GITHUB_WORKSPACE="$workspace" bash "$resolver" "$wrong_commit" \
  >/dev/null 2>&1; then
  printf 'resolver accepted the wrong source commit\n' >&2
  exit 1
fi

mkdir -p "$workspace/nested"
if env GITHUB_WORKSPACE="$workspace/nested" bash "$resolver" "$commit" \
  >/dev/null 2>&1; then
  printf 'resolver accepted a workspace below the repository root\n' >&2
  exit 1
fi

printf 'container-local source resolution passed\n'
