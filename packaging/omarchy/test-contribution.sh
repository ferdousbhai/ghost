#!/usr/bin/env bash

set -euo pipefail

script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
temp_base="${GHOST_OMARCHY_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p -- "$temp_base"
work="$(mktemp -d "$temp_base/ghost-omarchy-contribution.XXXXXXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

version=1.2.3
source_sha=0000000000000000000000000000000000000000000000000000000000000000
runtime_sha=1111111111111111111111111111111111111111111111111111111111111111
repository=example/ghost-releases

for mask in 022 077; do
  mkdir -m755 -- "$work/$mask"
  (
    umask "$mask"
    GHOST_RELEASE_REPOSITORY="$repository" \
      bash "$script_root/render-contribution.sh" \
        "$work/$mask/ghost" "$version" "$source_sha" "$runtime_sha"
  )
done
diff -ru "$work/022/ghost" "$work/077/ghost"

contribution="$work/077/ghost"
mapfile -t inventory < <(
  find "$contribution" -mindepth 1 -printf '%P\n' | LC_ALL=C sort
)
expected=(
  .omarchy
  .omarchy/package.json
  .omarchy/upstream.sh
  PKGBUILD
  ghost.install
)
[[ "${inventory[*]}" == "${expected[*]}" ]]
[[ "$(stat -c '%a' "$contribution")" == 755 ]]
[[ "$(stat -c '%a' "$contribution/.omarchy")" == 755 ]]
[[ "$(stat -c '%a' "$contribution/PKGBUILD")" == 644 ]]
[[ "$(stat -c '%a' "$contribution/ghost.install")" == 644 ]]
[[ "$(stat -c '%a' "$contribution/.omarchy/package.json")" == 644 ]]
[[ "$(stat -c '%a' "$contribution/.omarchy/upstream.sh")" == 755 ]]
jq -e '. == {source: "local"}' \
  "$contribution/.omarchy/package.json" >/dev/null
! jq -e 'has("release_ring")' "$contribution/.omarchy/package.json" >/dev/null

srcinfo="$work/ghost.SRCINFO"
(
  cd -- "$contribution"
  makepkg --printsrcinfo
) > "$srcinfo"
grep -Fxq 'pkgbase = ghost' "$srcinfo"
grep -Fxq 'pkgname = ghost' "$srcinfo"
grep -Fxq $'\tconflicts = ghost-dev' "$srcinfo"
grep -Fxq $'\tsource = ghost-1.2.3.tar.gz::https://github.com/example/ghost-releases/releases/download/v1.2.3/ghost-1.2.3.tar.gz' "$srcinfo"
grep -Fxq $'\tsource = ghost-runtime-1.2.3-linux-x86_64.tar.zst::https://github.com/example/ghost-releases/releases/download/v1.2.3/ghost-runtime-1.2.3-linux-x86_64.tar.zst' "$srcinfo"
! grep -Eq 'ghost-ai|summon-ghost|AUR|aur' "$contribution/PKGBUILD"

fake_bin="$work/bin"
mkdir -- "$fake_bin"
apply_fixture="$fake_bin/curl"
sed \
  -e "s|@@REPOSITORY@@|$repository|g" \
  -e "s|@@VERSION@@|$version|g" \
  "$script_root/test-fixtures/curl" > "$apply_fixture"
chmod 755 -- "$apply_fixture"
hook_output="$work/hook.json"
PATH="$fake_bin:$PATH" \
  GHOST_OMARCHY_FIXTURE_SOURCE_SHA="$source_sha" \
  GHOST_OMARCHY_FIXTURE_RUNTIME_SHA="$runtime_sha" \
  bash "$contribution/.omarchy/upstream.sh" > "$hook_output"
jq -e --arg source "$source_sha" --arg runtime "$runtime_sha" '
  . == {
    pkgver: "1.2.3",
    sha256sums: {any: [$source, $runtime]}
  }
' "$hook_output" >/dev/null

for mode in \
  duplicate-checksum \
  wrong-checksum-url \
  malformed-asset-after-valid \
  malformed-release-after-valid; do
  if PATH="$fake_bin:$PATH" \
      GHOST_OMARCHY_FIXTURE_MODE="$mode" \
      GHOST_OMARCHY_FIXTURE_SOURCE_SHA="$source_sha" \
      GHOST_OMARCHY_FIXTURE_RUNTIME_SHA="$runtime_sha" \
      bash "$contribution/.omarchy/upstream.sh" >/dev/null 2>&1; then
    printf 'upstream hook accepted fixture mode %s\n' "$mode" >&2
    exit 1
  fi
done

# Model the only fields official sync-upstream rewrites: pkgver, pkgrel, and
# the checksum array. The updated recipe must derive the new source identity;
# it must not retain a rendered commit or epoch from the first release.
next_version=2.0.0
next_source_sha=2222222222222222222222222222222222222222222222222222222222222222
next_runtime_sha=3333333333333333333333333333333333333333333333333333333333333333
next_bin="$work/next-bin"
mkdir -- "$next_bin"
sed \
  -e "s|@@REPOSITORY@@|$repository|g" \
  -e "s|@@VERSION@@|$next_version|g" \
  "$script_root/test-fixtures/curl" > "$next_bin/curl"
chmod 755 -- "$next_bin/curl"
next_update="$work/next-update.json"
PATH="$next_bin:$PATH" \
  GHOST_OMARCHY_FIXTURE_SOURCE_SHA="$next_source_sha" \
  GHOST_OMARCHY_FIXTURE_RUNTIME_SHA="$next_runtime_sha" \
  bash "$contribution/.omarchy/upstream.sh" > "$next_update"
[[ "$(jq -r '.pkgver' "$next_update")" == "$next_version" ]]
mapfile -t next_hashes < <(jq -r '.sha256sums.any[]' "$next_update")
[[ "${#next_hashes[@]}" -eq 2 ]]
[[ "${next_hashes[0]}" == "$next_source_sha" ]]
[[ "${next_hashes[1]}" == "$next_runtime_sha" ]]

updated="$work/updated-ghost"
cp -a -- "$contribution" "$updated"
sed -i \
  -e "s/^pkgver=.*/pkgver=$next_version/" \
  -e 's/^pkgrel=.*/pkgrel=1/' \
  -e "s/$source_sha/${next_hashes[0]}/" \
  -e "s/$runtime_sha/${next_hashes[1]}/" \
  "$updated/PKGBUILD"
! grep -Eq '_source_commit|_source_date_epoch|@@SOURCE_(COMMIT|DATE_EPOCH)@@' \
  "$updated/PKGBUILD"
updated_srcinfo="$work/updated.SRCINFO"
(
  cd -- "$updated"
  makepkg --printsrcinfo
) > "$updated_srcinfo"
grep -Fxq $'\tpkgver = 2.0.0' "$updated_srcinfo"
grep -Fxq $'\tsha256sums = '"$next_source_sha" "$updated_srcinfo"
grep -Fxq $'\tsha256sums = '"$next_runtime_sha" "$updated_srcinfo"
grep -Fq '/releases/download/v2.0.0/ghost-2.0.0.tar.gz' "$updated_srcinfo"

srcdir="$work/update-src"
CARCH=x86_64
# shellcheck disable=SC1090
source "$updated/PKGBUILD"
source_root="$srcdir/ghost-$pkgver"
runtime_root="$srcdir/runtime/ghost-runtime-$pkgver-linux-$CARCH"
manifest="$source_root/RELEASE-SOURCE.MANIFEST"
next_commit=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
next_epoch=234567890
mkdir -p -- \
  "$source_root/packaging/arch" \
  "$source_root/packaging/release" \
  "$source_root/packages/shell/contrib" \
  "$source_root/packages/chromium-extension/extension" \
  "$runtime_root"
write_manifest() {
  printf '%s\n' "$@" > "$manifest"
}
write_manifest \
  'format=ghost-release-source/v1' \
  "version=$pkgver" \
  "source_commit=$next_commit" \
  "source_date_epoch=$next_epoch"
[[ "$(_release_identity "$manifest")" == \
  "$next_commit"$'\t'"$next_epoch" ]]

assert_identity_rejected() {
  local label="$1"
  if _release_identity "$manifest" >/dev/null 2>&1; then
    printf 'release identity accepted %s\n' "$label" >&2
    exit 1
  fi
}
write_manifest \
  'format=ghost-release-source/v1' \
  'version=1.2.3' \
  "source_commit=$next_commit" \
  "source_date_epoch=$next_epoch"
assert_identity_rejected 'a stale version'
write_manifest \
  'format=ghost-release-source/v1' \
  "version=$pkgver" \
  "source_commit=$next_commit" \
  "source_commit=$next_commit" \
  "source_date_epoch=$next_epoch"
assert_identity_rejected 'a duplicate identity row'
write_manifest \
  'format=ghost-release-source/v1' \
  "version=$pkgver" \
  'source_commit=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' \
  "source_date_epoch=$next_epoch"
assert_identity_rejected 'a noncanonical commit'
write_manifest \
  'format=ghost-release-source/v1' \
  "version=$pkgver" \
  "source_commit=$next_commit" \
  'source_date_epoch=123x'
assert_identity_rejected 'a malformed epoch'
write_manifest \
  'format=ghost-release-source/v1' \
  "version=$pkgver" \
  "source_commit=$next_commit" \
  "source_date_epoch=$next_epoch" \
  'unexpected=value'
assert_identity_rejected 'an unexpected identity row'
outside_manifest="$work/outside-manifest"
printf 'fixture\n' > "$outside_manifest"
rm -- "$manifest"
ln -s -- "$outside_manifest" "$manifest"
assert_identity_rejected 'a symlinked manifest'
rm -- "$manifest"

# Exercise check() with the updated identity. The real runtime verifier has its
# own full v3 closure tests; this focused seam proves the recipe forwards the
# freshly derived identity and rejects a runtime manifest from another source.
write_manifest \
  'format=ghost-release-source/v1' \
  "version=$pkgver" \
  "source_commit=$next_commit" \
  "source_date_epoch=$next_epoch"
printf '#!/usr/bin/env bash\nexit 0\n' \
  > "$source_root/packaging/arch/test-check-dependencies.sh"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  'runtime_root="$1"; version="$3"; arch="$4"; commit="$5"; epoch="$6"' \
  'grep -Fxq "format=ghost-runtime-source/v3" "$runtime_root/MANIFEST"' \
  'grep -Fxq "version=$version" "$runtime_root/MANIFEST"' \
  'grep -Fxq "os=linux" "$runtime_root/MANIFEST"' \
  'grep -Fxq "arch=$arch" "$runtime_root/MANIFEST"' \
  'grep -Fxq "source_commit=$commit" "$runtime_root/MANIFEST"' \
  'grep -Fxq "source_date_epoch=$epoch" "$runtime_root/MANIFEST"' \
  > "$source_root/packaging/release/verify-runtime-source.sh"
cat > "$source_root/packages/shell/contrib/ghost.desktop" <<'EOF'
[Desktop Entry]
Type=Application
Name=Ghost
Exec=ghost
EOF
printf '{}\n' \
  > "$source_root/packages/chromium-extension/extension/manifest.json"
write_runtime_manifest() {
  local commit="$1"
  printf '%s\n' \
    'format=ghost-runtime-source/v3' \
    "version=$pkgver" \
    'os=linux' \
    "arch=$CARCH" \
    "source_commit=$commit" \
    "source_date_epoch=$next_epoch" \
    > "$runtime_root/MANIFEST"
}
write_runtime_manifest "$next_commit"
check
write_runtime_manifest cccccccccccccccccccccccccccccccccccccccc
if check >/dev/null 2>&1; then
  printf 'updated recipe accepted a mismatched runtime identity\n' >&2
  exit 1
fi

printf 'Omarchy contribution dry-run fixtures passed\n'
