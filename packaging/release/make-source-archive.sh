#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: make-source-archive.sh <source-root> <output> <version> [ref|--worktree]}"
output="${2:?usage: make-source-archive.sh <source-root> <output> <version> [ref|--worktree]}"
version="${3:?usage: make-source-archive.sh <source-root> <output> <version> [ref|--worktree]}"
ref="${4:-HEAD}"

source_root="$(realpath "$source_root")"
mkdir -p "$(dirname "$output")"
output="$(realpath "$(dirname "$output")")/$(basename "$output")"
temporary="${output}.tmp.$$"
temporary_tar="${output}.tar.tmp.$$"
manifest_parent="$(mktemp -d "$(dirname "$output")/source-manifest.XXXXXX")"
cleanup() {
  rm -f "$temporary" "$temporary_tar"
  find "$manifest_parent" -depth -delete
}
trap cleanup EXIT

if [[ "$ref" == --worktree ]]; then
  commit="$(git -C "$source_root" rev-parse 'HEAD^{commit}')"
else
  commit="$(git -C "$source_root" rev-parse "$ref^{commit}")"
fi
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$source_root" show -s --format=%ct "$commit")}"
[[ "$commit" =~ ^[0-9a-f]{40}$ && "$epoch" =~ ^[0-9]+$ ]]

manifest_dir="$manifest_parent/ghost-$version"
mkdir -p "$manifest_dir"
cat > "$manifest_dir/RELEASE-SOURCE.MANIFEST" <<EOF
format=ghost-release-source/v1
version=$version
source_commit=$commit
source_date_epoch=$epoch
EOF
chmod 644 "$manifest_dir/RELEASE-SOURCE.MANIFEST"
touch -d "@$epoch" "$manifest_dir/RELEASE-SOURCE.MANIFEST"

if [[ "$ref" == --worktree ]]; then
  (
    cd "$source_root"
    git ls-files -co --exclude-standard -z -- . \
      ':(exclude)AGENTS.md' ':(exclude,glob)**/AGENTS.md' \
      ':(exclude)CLAUDE.md' ':(exclude,glob)**/CLAUDE.md' \
      | while IFS= read -r -d '' path; do
          [[ -e "$path" || -L "$path" ]] && printf '%s\0' "$path"
        done \
      | tar --null --files-from=- --sort=name --format=gnu \
          --mtime="@$epoch" --owner=0 --group=0 --numeric-owner \
          --transform="s|^|ghost-${version}/|" -cf "$temporary_tar"
  )
else
  git -C "$source_root" archive --format=tar --prefix="ghost-${version}/" \
    "$ref" -- . ':(exclude)AGENTS.md' ':(exclude,glob)**/AGENTS.md' \
      ':(exclude)CLAUDE.md' ':(exclude,glob)**/CLAUDE.md' \
    > "$temporary_tar"
fi
tar --append --file="$temporary_tar" --mtime="@$epoch" --owner=0 --group=0 \
  --numeric-owner -C "$manifest_parent" "ghost-$version/RELEASE-SOURCE.MANIFEST"
gzip -n -9 < "$temporary_tar" > "$temporary"
mv "$temporary" "$output"
rm -f "$temporary_tar"
find "$manifest_parent" -depth -delete
trap - EXIT
