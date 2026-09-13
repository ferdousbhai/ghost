#!/usr/bin/env bash
# Publish the HUD plugin subtree to its distribution mirror.
#
# `omarchy plugin add` clones a repo whose root holds manifest.json, and this
# monorepo's root cannot be that: it carries a CLAUDE.md symlink, which the
# plugin validator refuses anywhere inside a plugin folder. So the mirror is
# packages/shell/qml on its own.
#
# The mirror carries its own history, one commit per release, rather than this
# repository's. Two reasons: what `omarchy plugin update` shows a user before
# it runs new code in their shell should be the plugin's changes and nothing
# else, and the mirror is a distribution artifact that need not publish how the
# monorepo was built. Each release commits the current subtree on top of the
# mirror's previous tip, so the history stays linear and every publish
# fast-forwards — which matters because `omarchy plugin update` is a
# fast-forward pull and a force-push would strand every installed copy.
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

# The manifest is what a user and the marketplace read as the plugin's version.
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

# The subtree's tree object, exactly as it is committed here.
tree="$(git rev-parse "HEAD:$prefix")"

# Continue the mirror's own chain when it has one.
parent=""
if git ls-remote --exit-code --heads "$mirror" master >/dev/null 2>&1; then
  parent="$(git fetch --quiet "$mirror" master && git rev-parse FETCH_HEAD)"
  if [[ "$(git rev-parse "$parent^{tree}")" == "$tree" ]]; then
    printf 'the mirror already carries this tree; nothing to publish\n'
    exit 0
  fi
fi

message="Ghost $version

The HUD plugin as released in ferdousbhai/ghost $tag. This repository is
published from that one; issues and pull requests belong there."

if (( dry_run )); then
  printf 'dry run: would commit tree %s%s and push master and %s to %s\n' \
    "$tree" "${parent:+ on $parent}" "$tag" "$mirror"
  exit 0
fi

commit="$(printf '%s' "$message" | git commit-tree "$tree" ${parent:+-p "$parent"})"
git push "$mirror" "$commit:refs/heads/master"
git push "$mirror" "$commit:refs/tags/$tag"
printf 'published the plugin mirror: %s %s (%s)\n' "$mirror" "$tag" "$commit"
