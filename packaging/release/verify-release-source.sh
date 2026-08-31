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

if find "$source_root" \( -type f -o -type l \) -name AGENTS.md \
  -print -quit | grep -q .; then
  printf 'release source contains private AGENTS.md instructions\n' >&2
  exit 1
fi
if find "$source_root" \( -type f -o -type l \) -name CLAUDE.md \
  -print -quit | grep -q .; then
  printf 'release source contains private CLAUDE.md instructions or aliases\n' >&2
  exit 1
fi

printf 'Verified release source: %s\n' "$source_root"
