#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: make-source-archive.sh <source-root> <output> <version> [ref|--worktree]}"
output="${2:?usage: make-source-archive.sh <source-root> <output> <version> [ref|--worktree]}"
version="${3:?usage: make-source-archive.sh <source-root> <output> <version> [ref|--worktree]}"
ref="${4:-HEAD}"

source_root="$(realpath "$source_root")"
mkdir -p "$(dirname "$output")"
temporary="${output}.tmp.$$"
trap 'rm -f "$temporary"' EXIT

if [[ "$ref" == --worktree ]]; then
  (
    cd "$source_root"
    git ls-files -co --exclude-standard -z \
      | tar --null --files-from=- --sort=name --format=gnu \
          --mtime="@${SOURCE_DATE_EPOCH:-0}" --owner=0 --group=0 --numeric-owner \
          --transform="s|^|ghost-${version}/|" -cf -
  ) | gzip -n -9 > "$temporary"
else
  git -C "$source_root" archive --format=tar --prefix="ghost-${version}/" "$ref" \
    | gzip -n -9 > "$temporary"
fi
mv "$temporary" "$output"
trap - EXIT

