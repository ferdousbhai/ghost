#!/usr/bin/env bash
set -euo pipefail

source_dir="${1:?usage: pack-aur-source.sh <source-dir> <archive> <epoch>}"
archive="${2:?usage: pack-aur-source.sh <source-dir> <archive> <epoch>}"
epoch="${3:?usage: pack-aur-source.sh <source-dir> <archive> <epoch>}"

source_dir="$(realpath "$source_dir")"
parent="$(dirname "$source_dir")"
name="$(basename "$source_dir")"
[[ "$epoch" =~ ^[0-9]+$ && "$name" == ghost-ai-*-aur ]]

mkdir -p "$(dirname "$archive")"
temporary="${archive}.tmp.$$"
trap 'rm -f "$temporary"' EXIT
tar --sort=name --format=gnu --mtime="@$epoch" --owner=0 --group=0 \
  --numeric-owner --mode='u+rwX,go+rX,go-w' -C "$parent" -cf - "$name" \
  | zstd -19 -T1 --no-progress -o "$temporary"
mv "$temporary" "$archive"
trap - EXIT
