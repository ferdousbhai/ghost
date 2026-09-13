#!/usr/bin/env bash
# Publish the HUD plugin subtree to its distribution mirror.
#
# `omarchy plugin add` clones a repo whose root holds manifest.json, and the
# monorepo's root cannot be that: it carries a CLAUDE.md symlink, which the
# plugin validator refuses anywhere inside a plugin folder. So the mirror is
# packages/shell/qml on its own, published by `git subtree split`.
#
# Split is deterministic: the same prefix history yields the same commits, so
# every publish fast-forwards. That matters because `omarchy plugin update` is
# a fast-forward pull, and a force-push would strand every installed copy.
#
#   packaging/release/publish-plugin.sh <version> [--dry-run]
set -euo pipefail

usage='publish-plugin.sh <version> [--dry-run]'
version="${1:?usage: $usage}"
dry_run=0
[[ "${2:-}" != "--dry-run" ]] || dry_run=1

script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_root/../..")"
mirror="${GHOST_PLUGIN_MIRROR:-https://github.com/ferdousbhai/omarchy-ghost.git}"
prefix=packages/shell/qml
tag="v$version"

cd -- "$source_root"

# The manifest is what users and the marketplace read as the plugin's version.
manifest_version="$(bun -e 'const m = await Bun.file("packages/shell/qml/manifest.json").json(); process.stdout.write(m.version)')"
[[ "$manifest_version" == "$version" ]] || {
  printf 'manifest.json says %s, not %s; bump it first\n' "$manifest_version" "$version" >&2
  exit 1
}
[[ -f "$prefix/README.md" && -f "$prefix/LICENSE" ]] || {
  printf 'the mirror needs %s/README.md and %s/LICENSE to stand alone\n' "$prefix" "$prefix" >&2
  exit 1
}
# A symlink anywhere inside would fail `omarchy plugin validate` after cloning.
if [[ -n "$(find "$prefix" -type l -print -quit)" ]]; then
  printf 'symlinks are not allowed inside a plugin folder\n' >&2
  exit 1
fi

split_commit="$(git subtree split -q --prefix="$prefix" HEAD)"
printf 'plugin subtree %s -> %s\n' "$prefix" "$split_commit"

if (( dry_run )); then
  printf 'dry run: would push %s to %s as master and %s\n' "$split_commit" "$mirror" "$tag"
  exit 0
fi

git push "$mirror" "$split_commit:refs/heads/master"
git push "$mirror" "$split_commit:refs/tags/$tag"
printf 'published the plugin mirror: %s %s\n' "$mirror" "$tag"
