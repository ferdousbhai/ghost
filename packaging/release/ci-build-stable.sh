#!/usr/bin/env bash

set -euo pipefail

(( EUID != 0 )) || {
  printf 'stable CI build must run as the package builder\n' >&2
  exit 1
}

workspace="${GITHUB_WORKSPACE:?GITHUB_WORKSPACE is required}"
script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
# shellcheck source=ci-release-paths.sh
source "$script_dir/ci-release-paths.sh"
ghost_ci_validate_release_paths

source_tree="$workspace/packaging/arch/src/ghost"
release_out="$GHOST_CI_RELEASE_OUT"
release_work="$GHOST_CI_RELEASE_WORK"

version="$(bash "$source_tree/packaging/release/verify-release-version.sh" \
  "$source_tree")"
commit="$(git -C "$source_tree" rev-parse HEAD)"
epoch="$(git -C "$source_tree" show -s --format=%ct "$commit")"
runtime="ghost-runtime-$version-linux-x86_64.tar.zst"
source_archive="$release_out/ghost-$version.tar.gz"
checkout_commit="$(git -C "$workspace" rev-parse 'HEAD^{commit}')"

if [[ "$checkout_commit" != "$commit" ]]; then
  printf 'package source commit %s does not match checkout %s\n' \
    "$commit" "$checkout_commit" >&2
  exit 1
fi

# The worktree source check must derive identity from the commit, not a caller's
# reproducibility environment.
SOURCE_DATE_EPOCH=1 \
  bash "$source_tree/packaging/release/test-release-source.sh"

expected_tag="v$version"
event_name="${EVENT_NAME:-}"
event_tag="${REF_NAME:-}"
if [[ "$event_name" == release ]]; then
  event_tag="${RELEASE_TAG:-}"
fi
if [[ "${REF_TYPE:-}" == tag || "$event_name" == release ]]; then
  if [[ "$event_tag" != "$expected_tag" ]]; then
    printf 'release ref %s does not match package.json version %s\n' \
      "$event_tag" "$version" >&2
    exit 1
  fi
  tag_commit="$(git -C "$workspace" rev-parse --verify \
    "$expected_tag^{commit}")"
  if [[ "$tag_commit" != "$commit" ]]; then
    printf 'tag %s resolves to %s, not checked-out commit %s\n' \
      "$expected_tag" "$tag_commit" "$commit" >&2
    exit 1
  fi
fi

SOURCE_DATE_EPOCH="$epoch" \
  bash "$source_tree/packaging/release/make-source-archive.sh" \
    "$source_tree" "$source_archive" "$version" HEAD
bash "$source_tree/packaging/release/prepare-pnpm-engine.sh" "$source_tree"
pnpm --dir "$source_tree" fetch --frozen-lockfile
(
  # shellcheck source=offline-env.sh
  source "$source_tree/packaging/release/offline-env.sh"
  GHOST_RELEASE_WORK_ROOT="$release_work" \
    SOURCE_DATE_EPOCH="$epoch" \
    bash "$source_tree/packaging/release/build-runtime-source.sh" \
      "$source_tree" "$release_out" "$version" x86_64 "$commit"
)

GHOST_RELEASE_WORK_ROOT="$release_work" \
  bash "$source_tree/packaging/release/smoke-runtime-source.sh" \
    "$release_out/$runtime" "$source_tree" "$version" x86_64 \
      "$commit" "$epoch"

source_sha="$(sha256sum "$source_archive" | cut -d' ' -f1)"
runtime_sha="$(sha256sum "$release_out/$runtime" | cut -d' ' -f1)"
GHOST_RELEASE_WORK_ROOT="$release_work" \
  bash "$source_tree/packaging/release/smoke-rendered-package.sh" \
    "$version" "$commit" "$epoch" "$source_sha" "$runtime_sha"
aur_dir="$release_work/ghost-ai-$version-aur"
bash "$source_tree/packaging/release/render-arch-package.sh" \
  "$aur_dir" "$version" "$commit" "$epoch" "$source_sha" "$runtime_sha"

install -d -m700 -- \
  "$release_work/makepkg-build" "$release_work/makepkg-sources"
(
  # shellcheck source=offline-env.sh
  source "$source_tree/packaging/release/offline-env.sh"
  GHOST_RELEASE_SOURCE_URL="file://$source_archive" \
    GHOST_RELEASE_RUNTIME_URL="file://$release_out/$runtime" \
    GHOST_RELEASE_WORK_ROOT="$release_work" \
    BUILDDIR="$release_work/makepkg-build" \
    SRCDEST="$release_work/makepkg-sources" \
    PKGDEST="$release_out" \
    makepkg --dir "$aur_dir" --cleanbuild --noconfirm
)

(
  cd -- "$aur_dir"
  makepkg --printsrcinfo > .SRCINFO.rendered
  cmp .SRCINFO .SRCINFO.rendered
  rm -- .SRCINFO.rendered
)

aur_bundle="$release_out/ghost-ai-$version-aur.tar.zst"
bash "$source_tree/packaging/release/pack-aur-source.sh" \
  "$aur_dir" "$aur_bundle" "$epoch"

mapfile -t development_packages < <(
  find "$workspace/packaging/arch" -maxdepth 1 -type f \
    -name 'ghost-ai-git-*.pkg.tar.zst' -print | LC_ALL=C sort
)
[[ "${#development_packages[@]}" -eq 1 ]] || {
  printf 'expected one development package, found %s\n' \
    "${#development_packages[@]}" >&2
  exit 1
}
cp -- "${development_packages[0]}" "$release_out/"
bash "$source_tree/packaging/release/write-sha256sums.sh" "$release_out"
bash "$script_dir/ci-verify-package-archives.sh"
