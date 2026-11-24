#!/usr/bin/env bash
set -euo pipefail

# The release's source archive: the tracked tree under ghost-<version>/, the
# same bytes for the same commit. --worktree takes the files as they are now
# (tracked or not ignored), for the gate to check before a commit exists.
usage='make-source-archive.sh <source-root> <output> <version> [ref|--worktree]'
source_root="$(realpath "${1:?usage: $usage}")"
output="${2:?usage: $usage}"
version="${3:?usage: $usage}"
ref="${4:-HEAD}"

mkdir -p "$(dirname "$output")"
temporary="${output}.tmp.$$"
trap 'rm -f "$temporary"' EXIT

if [[ "$ref" == --worktree ]]; then
  epoch="${SOURCE_DATE_EPOCH:-$(git -C "$source_root" show -s --format=%ct HEAD)}"
  (
    cd "$source_root"
    git ls-files -co --exclude-standard -z \
      | while IFS= read -r -d '' path; do
          [[ -e "$path" || -L "$path" ]] && printf '%s\0' "$path"
        done \
      | tar --null --files-from=- --sort=name --format=gnu \
          --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
          --transform="s|^|ghost-${version}/|S" -c
  ) | gzip -n -9 > "$temporary"
else
  git -C "$source_root" archive --format=tar --prefix="ghost-${version}/" "$ref" \
    | gzip -n -9 > "$temporary"
fi
mv "$temporary" "$output"
trap - EXIT
