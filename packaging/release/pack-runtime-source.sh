#!/usr/bin/env bash
set -euo pipefail

runtime_root="${1:?usage: pack-runtime-source.sh <runtime-root> <archive>}"
archive="${2:?usage: pack-runtime-source.sh <runtime-root> <archive>}"

runtime_root="$(realpath "$runtime_root")"
parent="$(dirname "$runtime_root")"
name="$(basename "$runtime_root")"
manifest="$runtime_root/MANIFEST"
epoch="$(sed -n 's/^source_date_epoch=//p' "$manifest")"

[[ "$epoch" =~ ^[0-9]+$ ]] || {
  printf 'runtime manifest has an invalid source_date_epoch\n' >&2
  exit 1
}

mkdir -p "$(dirname "$archive")"
temporary="${archive}.tmp.$$"
trap 'rm -f "$temporary"' EXIT

tar --sort=name --format=gnu --mtime="@$epoch" --owner=0 --group=0 \
  --numeric-owner --mode='u+rwX,go+rX,go-w' -C "$parent" -cf - "$name" \
  | zstd -19 -T1 --no-progress -o "$temporary"
mv "$temporary" "$archive"
trap - EXIT

