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
[[ "$arch" == x86_64 ]] || {
  printf 'unsupported release architecture: %s\n' "$arch" >&2
  exit 1
}
[[ "$(uname -s)" == Linux && "$(uname -m)" == "$arch" ]] || {
  printf 'release host %s/%s does not match linux/%s\n' \
    "$(uname -s)" "$(uname -m)" "$arch" >&2
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

work_parent="${GHOST_RELEASE_WORK_ROOT:-$output_dir/work}"
mkdir -p "$work_parent"
work="$(mktemp -d "$work_parent/runtime.XXXXXX")"
cleanup() {
  find "$work" -depth -delete
}
trap cleanup EXIT

name="ghost-runtime-${version}-linux-${arch}"
runtime_root="$work/$name"
daemon="$runtime_root/daemon"
mkdir -p "$runtime_root"

bash "$source_root/packaging/release/runtime-tree.sh" "$source_root" "$daemon"

if find "$daemon" ! \( -type f -o -type d -o -type l \) \
  -print -quit | grep -q .; then
  printf 'runtime payload contains a special filesystem entry\n' >&2
  exit 1
fi

# Bind the runtime to every frozen dependency input, including the in-tree
# catalog override and every dependency patch. The tagged source rechecks these
# before packaging.
bash "$source_root/packaging/release/frozen-inputs.sh" "$source_root" \
  > "$runtime_root/FROZEN-INPUTS.SHA256"

(
  cd "$runtime_root"
  find daemon -type f -print0 | LC_ALL=C sort -z | xargs -0 sha256sum
) > "$runtime_root/PAYLOAD.SHA256"

(
  cd "$runtime_root"
  while IFS= read -r -d '' link; do
    target="$(readlink "$link")"
    hash="$(printf '%s' "$target" | sha256sum | cut -d' ' -f1)"
    printf '%s  %s\n' "$hash" "$link"
  done < <(find daemon -type l -print0 | LC_ALL=C sort -z)
) > "$runtime_root/SYMLINKS.SHA256"

find "$runtime_root" -type d -exec chmod 755 {} +
find "$runtime_root" -type f -perm /111 -exec chmod 755 {} +
find "$runtime_root" -type f ! -perm /111 -exec chmod 644 {} +

(
  cd "$runtime_root"
  while IFS= read -r -d '' path; do
    kind=f
    [[ -d "$path" ]] && kind=d
    [[ -L "$path" ]] && kind=l
    printf '%s\t%s\t%s\n' "$(stat -c '%a' "$path")" "$kind" "$path"
  done < <(find daemon -print0 | LC_ALL=C sort -z)
) > "$runtime_root/PAYLOAD.MODES"

cat > "$runtime_root/MANIFEST" <<EOF
format=ghost-runtime-source/v1
version=$version
os=linux
arch=$arch
source_commit=$commit
source_date_epoch=$epoch
frozen_inputs_sha256=$(sha256sum "$runtime_root/FROZEN-INPUTS.SHA256" | cut -d' ' -f1)
payload_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)
symlink_manifest_sha256=$(sha256sum "$runtime_root/SYMLINKS.SHA256" | cut -d' ' -f1)
modes_manifest_sha256=$(sha256sum "$runtime_root/PAYLOAD.MODES" | cut -d' ' -f1)
EOF
chmod 644 "$runtime_root"/{MANIFEST,FROZEN-INPUTS.SHA256,PAYLOAD.SHA256,SYMLINKS.SHA256,PAYLOAD.MODES}
find "$runtime_root" -exec touch -h -d "@$epoch" {} +

archive="$output_dir/$name.tar.zst"
bash "$source_root/packaging/release/pack-runtime-source.sh" "$runtime_root" "$archive"
(
  cd "$output_dir"
  sha256sum "$(basename "$archive")" > "$(basename "$archive").sha256"
)
printf '%s\n' "$archive"
