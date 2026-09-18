#!/usr/bin/env bash

# Exercise the root-safe .SRCINFO dependency parser with versioned,
# architecture-qualified, malformed, and option-shaped entries.

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
parser="$script_dir/ci-dependencies.sh"
temp_base="${GHOST_ARCH_DEPENDENCY_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-ci-dependencies.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

write_valid_fixture() {
  printf '%s\n' \
    'pkgbase = fixture' \
    $'\tdepends = alpha>=1.2' \
    $'\tdepends_x86_64 = beta' \
    $'\tmakedepends = gamma=2:1.0-3' \
    $'\tmakedepends_x86_64 = delta' \
    $'\tcheckdepends = epsilon<3' \
    $'\tcheckdepends_x86_64 = zeta' \
    > "$work/valid.SRCINFO"
}

write_valid_fixture
bash "$parser" --srcinfo "$work/valid.SRCINFO" --constraints \
  > "$work/constraints.actual"
printf '%s\n' \
  'alpha>=1.2' beta delta 'epsilon<3' 'gamma=2:1.0-3' zeta \
  > "$work/constraints.expected"
cmp "$work/constraints.expected" "$work/constraints.actual"

bash "$parser" --srcinfo "$work/valid.SRCINFO" --names \
  > "$work/names.actual"
printf '%s\n' alpha beta delta epsilon gamma zeta > "$work/names.expected"
cmp "$work/names.expected" "$work/names.actual"

# Dependencies produced by this split build must not be installed from pacman.
cat >> "$work/valid.SRCINFO" <<'EOF'
pkgname = fixture-runtime
pkgname = fixture-ui
	depends = fixture-runtime=1.2-3
EOF
bash "$parser" --srcinfo "$work/valid.SRCINFO" --constraints > "$work/split.actual"
cmp "$work/constraints.expected" "$work/split.actual"

for invalid in \
  $'\tcheckdepends = --config=/outside' \
  $'\tcheckdepends = .hidden' \
  $'\tdepends_x86_64 = valid extra' \
  $'\tmakedepends = package=>1' \
  $'\tdepends_x86_64 == package'; do
  printf '%s\n' 'pkgbase = fixture' "$invalid" > "$work/invalid.SRCINFO"
  if bash "$parser" --srcinfo "$work/invalid.SRCINFO" --names \
      > /dev/null 2>&1; then
    printf 'dependency parser accepted invalid metadata: %s\n' "$invalid" >&2
    exit 1
  fi
done

printf '%s\n' 'pkgbase = empty' > "$work/empty.SRCINFO"
if bash "$parser" --srcinfo "$work/empty.SRCINFO" --names > /dev/null 2>&1; then
  printf 'dependency parser accepted empty metadata\n' >&2
  exit 1
fi

ln -s valid.SRCINFO "$work/link.SRCINFO"
if bash "$parser" --srcinfo "$work/link.SRCINFO" --names > /dev/null 2>&1; then
  printf 'dependency parser accepted symlinked metadata\n' >&2
  exit 1
fi

if (( EUID == 0 )); then
  GHOST_ARCH_CHECK_RUNTIME_TEST_ROOT="$work" \
    bash "$script_dir/test-check-runtime.sh" --root-refusal-only
fi

printf 'Arch CI dependency parser passed\n'
