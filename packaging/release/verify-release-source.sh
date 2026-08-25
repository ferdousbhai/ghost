#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: verify-release-source.sh <source-root> <version> <commit> <epoch>}"
version="${2:?usage: verify-release-source.sh <source-root> <version> <commit> <epoch>}"
commit="${3:?usage: verify-release-source.sh <source-root> <version> <commit> <epoch>}"
epoch="${4:?usage: verify-release-source.sh <source-root> <version> <commit> <epoch>}"
manifest="$source_root/RELEASE-SOURCE.MANIFEST"

[[ -f "$manifest" ]]
grep -Fxq 'format=ghost-release-source/v1' "$manifest"
grep -Fxq "version=$version" "$manifest"
grep -Fxq "source_commit=$commit" "$manifest"
grep -Fxq "source_date_epoch=$epoch" "$manifest"

source_version="$(bun -e \
  "const p = await Bun.file(process.argv[1]).json(); process.stdout.write(p.version)" \
  "$source_root/package.json")"
[[ "$source_version" == "$version" ]] || {
  printf 'release source package.json version mismatch: expected %s, got %s\n' \
    "$version" "$source_version" >&2
  exit 1
}

printf 'Verified release source: %s\n' "$source_root"
