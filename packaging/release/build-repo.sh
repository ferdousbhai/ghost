#!/usr/bin/env bash
# Build the `ghost-runtime` and `ghost` packages from the rendered recipe and
# the release archives, sign them, and write a one-release pacman repository
# that a GitHub release can serve. publish.sh runs this after rendering; the
# result is what install.sh adds as the [ghost] repository until
# Omarchy's own repository carries the package.
#
#   build-repo.sh <out-dir> <version>
#
# Reads <out-dir>/ghost-<version>.tar.gz, the runtime archive, and
# <out-dir>/omarchy-ghost-<version>/ (PKGBUILD + install hooks). Writes
# <out-dir>/repo/: both packages with detached signatures, ghost.db and
# ghost.files (and their .tar.gz forms) with signatures, and the public key.
# Signs with the key whose fingerprint package-signing-key.fingerprint pins,
# the same one the install script trusts.
set -euo pipefail

usage='build-repo.sh <out-dir> <version>'
out="$(realpath -e -- "${1:?usage: $usage}")"
version="${2:?usage: $usage}"
script_root="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

fingerprint="$(tr -d '[:space:]' < "$script_root/package-signing-key.fingerprint")"
[[ "$fingerprint" =~ ^[0-9A-F]{40}$ ]] || {
  printf 'package-signing-key.fingerprint does not hold a fingerprint\n' >&2
  exit 1
}
gpg --batch --list-secret-keys "$fingerprint" >/dev/null 2>&1 || {
  printf 'the package-signing key %s is not in this keyring\n' "$fingerprint" >&2
  exit 1
}

rendered="$out/omarchy-ghost-$version"
work_parent="${GHOST_RELEASE_WORK_ROOT:-$script_root/work}"
mkdir -p -- "$work_parent"
build="$(mktemp -d "$work_parent/repo-build.XXXXXX")"
cleanup() {
  find "$build" -depth -delete
}
trap cleanup EXIT

cp -- "$rendered/PKGBUILD" "$rendered"/*.install "$build/"
# makepkg uses a source it finds beside the PKGBUILD instead of downloading
# it; the release URLs the recipe names do not exist until publish.sh creates
# the release. The checksums it verifies are the ones rendered from these files.
cp -- "$out/ghost-$version.tar.gz" "$out/ghost-runtime-$version-linux-any.tar.zst" "$build/"

repo="$out/repo"
rm -rf -- "$repo"
mkdir -p -- "$repo"
(
  cd -- "$build"
  LC_ALL=C GPGKEY="$fingerprint" PKGDEST="$repo" makepkg --force --sign
)
(
  cd -- "$repo"
  repo-add --sign --verify ghost.db.tar.gz ./*.pkg.tar.zst
  # repo-add leaves the names pacman asks for (ghost.db, ghost.files and
  # their .sig) as symlinks, which a GitHub release cannot hold: copy them.
  for name in db files; do
    rm -f -- "ghost.$name" "ghost.$name.sig"
    cp -- "ghost.$name.tar.gz" "ghost.$name"
    cp -- "ghost.$name.tar.gz.sig" "ghost.$name.sig"
  done
  gpg --batch --armor --export "$fingerprint" > ghost-signing-key.asc
)
printf 'signed [ghost] repository for %s:\n' "$version"
ls -1 -- "$repo"
