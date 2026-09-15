#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
output_dir="${2:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
version="${3:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
arch="${4:?usage: build-runtime-source.sh <source-root> <output-dir> <version> <arch> [commit]}"
commit="${5:-}"

source_root="$(realpath "$source_root")"
mkdir -p "$output_dir"
output_dir="$(realpath "$output_dir")"

[[ "$version" =~ ^[0-9]+([.][0-9]+){2}([.][a-z0-9]+)*$ ]] || {
  printf 'invalid release version: %s\n' "$version" >&2
  exit 1
}
# The payload is Bun-target JavaScript (plus wasm) with no native modules, so
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
if [[ "${GHOST_ALLOW_DIRTY_SOURCE:-0}" != 1 ]]; then
  dirty="$(git -C "$source_root" status --porcelain --untracked-files=normal)"
  if [[ -n "$dirty" ]]; then
    printf 'release runtime source is dirty; build from a clean tag checkout\n%s\n' \
      "$dirty" >&2
    exit 1
  fi
fi
epoch="${SOURCE_DATE_EPOCH:-$(git -C "$source_root" show -s --format=%ct "$commit")}"
[[ "$epoch" =~ ^[0-9]+$ ]] || {
  printf 'invalid SOURCE_DATE_EPOCH: %s\n' "$epoch" >&2
  exit 1
}

bun_build_version="$(bun --version)"
bun_runtime_min="$(bun -e '
  const p = await Bun.file(process.argv[1]).json();
  const match = /^>=(\d+\.\d+\.\d+)$/.exec(p.engines?.bun ?? "");
  if (!match) process.exit(1);
  process.stdout.write(match[1]);
' "$source_root/packages/daemon/package.json")"
bundle_target=bun

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
  # Populate dependencies only from the pre-seeded store and frozen lockfile.
  # Lifecycle scripts stay disabled; in particular, onnxruntime-node must not
  # download optional CUDA provider libraries while assembling a release.
  export ONNXRUNTIME_NODE_INSTALL=skip
  pnpm install --ignore-scripts --offline --frozen-lockfile
  pnpm build
  pnpm --filter @ghost/daemon build:runtime
)
cp -a "$source_root/packages/daemon/dist/runtime/." "$runtime_root/"
find -P "$runtime_root" -type d -exec chmod 755 {} +
find -P "$runtime_root" -type f ! -path "$runtime_root/bin/*" -exec chmod 644 {} +
chmod 755 "$runtime_root/bin/ghostd" "$runtime_root/bin/ghost"

(
  cd "$runtime_root"
  find . -type f ! -name MANIFEST ! -name PAYLOAD.SHA256 -printf '%P\0' \
    | LC_ALL=C sort -z \
    | xargs -0 sha256sum > PAYLOAD.SHA256
)

cat > "$runtime_root/MANIFEST" <<EOF
format=ghost-runtime-source/v3
version=$version
os=linux
arch=$arch
source_commit=$commit
source_date_epoch=$epoch
bun_build_version=$bun_build_version
bun_runtime_min=$bun_runtime_min
bundle_target=$bundle_target
bundled_license_manifest_sha256=$(sha256sum "$runtime_root/BUNDLED-LICENSES" | cut -d' ' -f1)
payload_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)
EOF
chmod 644 "$runtime_root"/{MANIFEST,PAYLOAD.SHA256}
find "$runtime_root" -exec touch -h -d "@$epoch" {} +

archive="$output_dir/$name.tar.zst"
bash "$source_root/packaging/release/pack-runtime-source.sh" "$runtime_root" "$archive"
(
  cd "$output_dir"
  sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256"
)
printf '%s\n' "$archive"
