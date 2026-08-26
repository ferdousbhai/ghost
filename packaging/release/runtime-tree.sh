#!/usr/bin/env bash

# Build the daemon's self-contained production tree from an already-populated
# pnpm store. This script never fetches: release CI seeds the store explicitly,
# then every install/deploy below is offline and frozen.

set -euo pipefail

source_root="${1:?usage: runtime-tree.sh <source-root> <destination>}"
destination="${2:?usage: runtime-tree.sh <source-root> <destination>}"

source_root="$(realpath "$source_root")"
destination_parent="$(dirname "$destination")"
mkdir -p "$destination_parent"
destination_parent="$(realpath "$destination_parent")"
destination="$destination_parent/$(basename "$destination")"
[[ ! -e "$destination" && ! -L "$destination" ]] || {
  printf 'runtime destination already exists: %s\n' "$destination" >&2
  exit 1
}

unlink_references_to() {
  local tree="$1"
  local target="$2"
  local link resolved

  while IFS= read -r -d '' link; do
    resolved="$(realpath -m "$link")"
    case "$resolved" in
      "$target"|"$target"/*) unlink "$link" ;;
    esac
  done < <(find "$tree" -type l -print0)
}

remove_tree() {
  local target="$1"
  [[ -e "$target" ]] || return 0
  find "$target" -depth -delete
}

prune_optional_package() {
  local daemon_dir="$1"
  local pattern="$2"
  local package_dir

  while IFS= read -r -d '' package_dir; do
    unlink_references_to "$daemon_dir" "$package_dir"
    remove_tree "$package_dir"
  done < <(find "$daemon_dir/node_modules/.pnpm" -mindepth 1 -maxdepth 1 \
    -type d -name "$pattern" -print0)
}

(
  cd "$source_root"
  # Dependency lifecycle scripts are deliberately disabled: onnxruntime-node,
  # for example, otherwise downloads optional CUDA provider libraries from
  # NuGet. The bundled CPU runtime is the portable release baseline. Force a
  # reconstruction from the pre-seeded pnpm store so a preceding development
  # install cannot mask an undeclared input.
  export ONNXRUNTIME_NODE_INSTALL=skip
  pnpm install --ignore-scripts --offline --frozen-lockfile --force
  pnpm build
  bash packaging/release/deploy-runtime.sh "$source_root" "$destination"
)

# The release source is for Arch x86_64 glibc. Keep the supported native
# payload and remove only known foreign optional binaries.
prune_optional_package "$destination" '@anthropic-ai+claude-agent-sdk-linux-x64-musl@*'
prune_optional_package "$destination" '@img+sharp-libvips-linuxmusl-x64@*'
prune_optional_package "$destination" '@img+sharp-linuxmusl-x64@*'
prune_optional_package "$destination" 'lightningcss-linux-x64-musl@*'
for foreign_dir in \
  "$destination/node_modules/.pnpm/onnxruntime-node@"*/node_modules/onnxruntime-node/bin/napi-v6/linux/arm64 \
  "$destination/node_modules/.pnpm/onnxruntime-node@"*/node_modules/onnxruntime-node/bin/napi-v6/darwin \
  "$destination/node_modules/.pnpm/onnxruntime-node@"*/node_modules/onnxruntime-node/bin/napi-v6/win32; do
  [[ -e "$foreign_dir" ]] || continue
  unlink_references_to "$destination" "$foreign_dir"
  remove_tree "$foreign_dir"
done

if find "$destination/node_modules/.pnpm" -path \
  '*/onnxruntime-node/bin/napi-v6/linux/x64/libonnxruntime_providers_*.so' \
  -print -quit | grep -q .; then
  printf 'runtime contains non-frozen optional ONNX CUDA provider libraries\n' >&2
  exit 1
fi

# A release source must remain closed after its checkout disappears.
while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  if [[ "$target" == /* ]]; then
    resolved="$(realpath -m "$target")"
  else
    resolved="$(realpath -m "$(dirname "$link")/$target")"
  fi
  case "$resolved" in
    "$destination"/*) ;;
    *)
      printf 'runtime symlink escapes payload: %s -> %s\n' \
        "${link#"$destination"/}" "$resolved" >&2
      exit 1
      ;;
  esac
  if [[ ! -e "$resolved" ]]; then
    printf 'runtime symlink is broken: %s\n' "${link#"$destination"/}" >&2
    exit 1
  fi
done < <(find "$destination" -type l -print0)
