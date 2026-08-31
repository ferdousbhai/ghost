#!/usr/bin/env bash
set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_dir/../..")"
test_parent="${GHOST_RELEASE_SOURCE_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$test_parent"
work="$(mktemp -d "$test_parent/ghost-release-source.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

version="$(bun -e 'process.stdout.write((await Bun.file(process.argv[1]).json()).version)' "$source_root/package.json")"
commit="$(git -C "$source_root" rev-parse 'HEAD^{commit}')"
epoch="$(git -C "$source_root" show -s --format=%ct "$commit")"
archive="$work/ghost-$version.tar.gz"
bash "$script_dir/make-source-archive.sh" \
  "$source_root" "$archive" "$version" --worktree
tar -xf "$archive" -C "$work"
extracted="$work/ghost-$version"

[[ ! -e "$extracted/.git" && ! -L "$extracted/.git" \
  && ! -e "$extracted/CLAUDE.md" && ! -L "$extracted/CLAUDE.md" \
  && -f "$extracted/CONTRACTS.md" ]]
if find "$extracted" \( -type f -o -type l \) \
  \( -name AGENTS.md -o -name CLAUDE.md \) -print -quit | grep -q .; then
  printf 'source archive retained private instruction files or aliases\n' >&2
  exit 1
fi
bash "$script_dir/verify-release-source.sh" \
  "$extracted" "$version" "$commit" "$epoch"

mkdir -p "$extracted/nested"
printf 'private fixture\n' > "$extracted/nested/AGENTS.md"
if bash "$script_dir/verify-release-source.sh" \
  "$extracted" "$version" "$commit" "$epoch" > "$work/rejected.out" 2>&1; then
  printf 'release verifier accepted AGENTS.md\n' >&2
  exit 1
fi
grep -Fq 'private AGENTS.md instructions' "$work/rejected.out"
rm "$extracted/nested/AGENTS.md"
ln -s ../CONTRACTS.md "$extracted/nested/AGENTS.md"
if bash "$script_dir/verify-release-source.sh" \
  "$extracted" "$version" "$commit" "$epoch" > "$work/rejected-link.out" 2>&1; then
  printf 'release verifier accepted an AGENTS.md alias\n' >&2
  exit 1
fi
grep -Fq 'private AGENTS.md instructions' "$work/rejected-link.out"
rm "$extracted/nested/AGENTS.md"

# The stable package invokes this shared check from an extracted source archive,
# where Git metadata is deliberately absent.
GHOST_ARCH_DEPENDENCY_TEST_ROOT="$work/stable-check-work" \
  bash "$extracted/packaging/arch/test-check-dependencies.sh"
printf 'Release source privacy regression passed\n'
