#!/usr/bin/env bash
set -euo pipefail

# The packaging checks, run where the package build runs them: inside an
# extracted source archive, with no Git metadata. A file the archive loses or
# a link it breaks fails here.
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_dir/../..")"
work="$(mktemp -d "${TMPDIR:-/tmp}/ghost-release-source.XXXXXX")"
trap 'find -P "$work" -depth -delete' EXIT

version="$(bash "$script_dir/verify-release-version.sh" "$source_root")"
bash "$script_dir/make-source-archive.sh" "$source_root" "$work/ghost-$version.tar.gz" "$version" --worktree
tar -xf "$work/ghost-$version.tar.gz" -C "$work"
extracted="$work/ghost-$version"
[[ ! -e "$extracted/.git" && -f "$extracted/CONTRACTS.md" ]]

mkdir "$work/tmp"
TMPDIR="$work/tmp" bash "$extracted/packaging/check.sh"
printf 'Release source check passed\n'
