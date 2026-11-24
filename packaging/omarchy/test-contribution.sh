#!/usr/bin/env bash

set -euo pipefail

script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
temp_base="${TMPDIR:-/tmp}"
mkdir -p -- "$temp_base"
work="$(mktemp -d "$temp_base/ghost-omarchy-contribution.XXXXXXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

version=1.2.3
source_sha=0000000000000000000000000000000000000000000000000000000000000000
repository=example/ghost

for mask in 022 077; do
  mkdir -m755 -- "$work/$mask"
  (
    umask "$mask"
    GHOST_RELEASE_REPOSITORY="$repository" \
      bash "$script_root/render-contribution.sh" \
        "$work/$mask/ghost" "$version" "$source_sha"
  )
done
diff -ru "$work/022/ghost" "$work/077/ghost"

# The renderer refuses a nonempty output, leaving it intact, and a version
# verify-release-version.sh would refuse.
guard="$work/nonempty"
mkdir -p -- "$guard"
printf 'preserve\n' > "$guard/sentinel"
if bash "$script_root/render-contribution.sh" \
    "$guard" "$version" "$source_sha" >/dev/null 2>&1; then
  printf 'renderer accepted a nonempty output directory\n' >&2
  exit 1
fi
grep -Fxq preserve "$guard/sentinel"
if bash "$script_root/render-contribution.sh" \
    "$work/invalid" 01.2.3 "$source_sha" >/dev/null 2>&1; then
  printf 'renderer accepted an invalid version\n' >&2
  exit 1
fi

contribution="$work/077/ghost"
mapfile -t inventory < <(
  find "$contribution" -mindepth 1 -printf '%P\n' | LC_ALL=C sort
)
expected=(
  .omarchy
  .omarchy/package.json
  PKGBUILD
  ghost.install
)
[[ "${inventory[*]}" == "${expected[*]}" ]]
[[ "$(stat -c '%a' "$contribution")" == 755 ]]
[[ "$(stat -c '%a' "$contribution/.omarchy")" == 755 ]]
[[ "$(stat -c '%a' "$contribution/PKGBUILD")" == 644 ]]
[[ "$(stat -c '%a' "$contribution/ghost.install")" == 644 ]]
[[ "$(stat -c '%a' "$contribution/.omarchy/package.json")" == 644 ]]
# The declarative upstream block is what omarchy-pkgs' sync-upstream reads;
# a hook alongside it would be an error there. Release files are `assets`,
# named within the release and checked against GitHub's own digests, the
# form omarchy-pkgs uses for a GitHub release feed.
jq -e --arg repository "$repository" '
  .source == "local"
  and .release_ring == "fast"
  and .upstream.github == $repository
  and .upstream.digests == true
  and (.upstream | has("sources") | not)
  and .upstream.assets.any == ["ghost-{pkgver}.tar.gz"]
' "$contribution/.omarchy/package.json" >/dev/null

srcinfo="$work/ghost.SRCINFO"
(
  cd -- "$contribution"
  makepkg --printsrcinfo
) > "$srcinfo"
grep -Fxq 'pkgbase = ghost' "$srcinfo"
grep -Fxq 'pkgname = ghost' "$srcinfo"
grep -Fxq $'\tconflicts = ghost-runtime' "$srcinfo"
grep -Fxq $'\treplaces = ghost-runtime' "$srcinfo"
grep -Fxq $'\tsource = ghost-1.2.3.tar.gz::https://github.com/example/ghost/releases/download/v1.2.3/ghost-1.2.3.tar.gz' "$srcinfo"
grep -Fxq $'\tsha256sums = '"$source_sha" "$srcinfo"
grep -Fxq $'\tmakedepends = pnpm>=10.12.2' "$srcinfo"

# Model the only fields sync-upstream rewrites: pkgver, pkgrel, and the
# checksum.
next_version=2.0.0
next_hash=2222222222222222222222222222222222222222222222222222222222222222
updated="$work/updated-ghost"
cp -a -- "$contribution" "$updated"
sed -i \
  -e "s/^pkgver=.*/pkgver=$next_version/" \
  -e 's/^pkgrel=.*/pkgrel=1/' \
  -e "s/$source_sha/$next_hash/" \
  "$updated/PKGBUILD"
updated_srcinfo="$work/updated.SRCINFO"
(
  cd -- "$updated"
  makepkg --printsrcinfo
) > "$updated_srcinfo"
grep -Fxq $'\tpkgver = 2.0.0' "$updated_srcinfo"
grep -Fxq $'\tsha256sums = '"$next_hash" "$updated_srcinfo"
grep -Fq '/releases/download/v2.0.0/ghost-2.0.0.tar.gz' "$updated_srcinfo"

printf 'Omarchy contribution dry-run fixtures passed\n'

# The Omarchy menu scripts and entries travel upstream verbatim.
for script in "$script_root"/bin/omarchy-install-ai-ghost "$script_root"/bin/omarchy-remove-ai-ghost; do
  bash -n "$script"
  [[ "$(stat -c '%a' "$script")" == 755 ]]
  grep -q '^# omarchy:summary=' "$script"
done
grep -Fq 'omarchy-pkg-add ghost' "$script_root/bin/omarchy-install-ai-ghost"
grep -Fq 'systemctl --user enable --now ghostd.service' "$script_root/bin/omarchy-install-ai-ghost"
grep -Fq 'omarchy-pkg-drop ghost' "$script_root/bin/omarchy-remove-ai-ghost"
grep -Fq '"install.ai.ghost"' "$script_root/omarchy-menu.jsonc"
grep -Fq '"remove.ai.ghost"' "$script_root/omarchy-menu.jsonc"
grep -Fq 'omarchy-install-ai-ghost' "$script_root/omarchy-menu.jsonc"
grep -Fq 'omarchy-remove-ai-ghost' "$script_root/omarchy-menu.jsonc"

printf 'Omarchy contribution test passed\n'
