#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
output_dir="${2:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
version="${3:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
arch="${4:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
commit="${5:-}"

source_root="$(realpath "$source_root")"
# shellcheck source=runtime-manifest.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/runtime-manifest.sh"
mkdir -p "$output_dir"
output_dir="$(realpath "$output_dir")"

# The payload is Bun-target JavaScript with no native modules, so
# one archive serves every Linux architecture Bun runs on; "any" is the only
# architecture token (proved on aarch64 under emulation, ghost#52).
[[ "$arch" == any ]] || {
  printf 'unsupported release architecture: %s (the runtime archive is "any")\n' "$arch" >&2
  exit 1
}
[[ "$(uname -s)" == Linux ]] || {
  printf 'release host %s is not linux\n' "$(uname -s)" >&2
  exit 1
}
source_version="$(bun -e \
  "const p = await Bun.file(process.argv[1]).json(); process.stdout.write(p.version)" \
  "$source_root/package.json")"
[[ "$source_version" == "$version" ]] || {
  printf 'package.json version %s does not match release version %s\n' \
    "$source_version" "$version" >&2
  exit 1
}

if [[ -z "$commit" ]]; then
  commit="$(git -C "$source_root" rev-parse HEAD)"
fi
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || {
  printf 'invalid source commit: %s\n' "$commit" >&2
  exit 1
}
head_commit="$(git -C "$source_root" rev-parse HEAD)"
[[ "$head_commit" == "$commit" ]] || {
  printf 'source checkout is %s, not requested commit %s\n' "$head_commit" "$commit" >&2
  exit 1
}
dirty="$(git -C "$source_root" status --porcelain --untracked-files=normal)"
if [[ -n "$dirty" ]]; then
  printf 'release runtime source is dirty; build from a clean tag checkout\n%s\n' \
    "$dirty" >&2
  exit 1
fi
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$source_root" show -s --format=%ct "$commit")}"
[[ "$epoch" =~ ^[0-9]+$ ]] || {
  printf 'invalid SOURCE_DATE_EPOCH: %s\n' "$epoch" >&2
  exit 1
}

bun_build_version="$(bun --version)"
bun_runtime_min="$(bun_runtime_min "$source_root")"

work_parent="${GHOST_RELEASE_WORK_ROOT:-$output_dir/work}"
mkdir -p "$work_parent"
work="$(mktemp -d "$work_parent/runtime.XXXXXX")"
cleanup() {
  find "$work" -depth -delete
}
trap cleanup EXIT

name="ghost-runtime-${version}-linux-${arch}"
runtime_root="$work/$name"
mkdir -p "$runtime_root"

(
  cd "$source_root"
  # Populate dependencies only from the pre-seeded store and frozen lockfile,
  # with lifecycle scripts disabled so no dependency can fetch at release time.
  pnpm install --ignore-scripts --offline --frozen-lockfile
  pnpm build
  pnpm --filter @ghost/daemon build:runtime
)
# build-runtime.sh already set the payload's modes; cp -a keeps them.
cp -a "$source_root/packages/daemon/dist/runtime/." "$runtime_root/"

payload_hashes "$runtime_root" > "$runtime_root/PAYLOAD.SHA256"
runtime_manifest "$runtime_root" "$version" "$arch" "$commit" "$epoch" \
  "$bun_build_version" "$bun_runtime_min" > "$runtime_root/MANIFEST"
chmod 644 "$runtime_root"/{MANIFEST,PAYLOAD.SHA256}
find "$runtime_root" -exec touch -h -d "@$epoch" {} +

archive="$output_dir/$name.tar.zst"
bash "$source_root/packaging/release/pack-runtime-source.sh" "$runtime_root" "$archive"
printf '%s\n' "$archive"
