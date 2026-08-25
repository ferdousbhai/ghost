#!/usr/bin/env bash
set -euo pipefail

runtime_root="${1:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit>}"
source_root="${2:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit>}"
version="${3:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit>}"
arch="${4:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit>}"
commit="${5:?usage: verify-runtime-source.sh <runtime-root> <source-root> <version> <arch> <commit>}"

runtime_root="$(realpath "$runtime_root")"
source_root="$(realpath "$source_root")"
manifest="$runtime_root/MANIFEST"

manifest_value() {
  local key="$1"
  sed -n "s/^${key}=//p" "$manifest"
}

expect_manifest() {
  local key="$1"
  local expected="$2"
  local actual
  actual="$(manifest_value "$key")"
  if [[ "$actual" != "$expected" ]]; then
    printf 'runtime manifest %s mismatch: expected %s, got %s\n' \
      "$key" "$expected" "$actual" >&2
    exit 1
  fi
}

[[ -f "$manifest" && -d "$runtime_root/daemon" ]]
expect_manifest format ghost-runtime-source/v1
expect_manifest version "$version"
expect_manifest os linux
expect_manifest arch "$arch"
expect_manifest source_commit "$commit"
expect_manifest frozen_inputs_sha256 \
  "$(sha256sum "$runtime_root/FROZEN-INPUTS.SHA256" | cut -d' ' -f1)"
expect_manifest payload_manifest_sha256 \
  "$(sha256sum "$runtime_root/PAYLOAD.SHA256" | cut -d' ' -f1)"
expect_manifest symlink_manifest_sha256 \
  "$(sha256sum "$runtime_root/SYMLINKS.SHA256" | cut -d' ' -f1)"
expect_manifest modes_manifest_sha256 \
  "$(sha256sum "$runtime_root/PAYLOAD.MODES" | cut -d' ' -f1)"

(
  cd "$source_root"
  sha256sum --quiet -c "$runtime_root/FROZEN-INPUTS.SHA256"
)
(
  cd "$runtime_root"
  sha256sum --quiet -c PAYLOAD.SHA256
)

temporary="$(mktemp -d "${GHOST_RELEASE_WORK_ROOT:-$(dirname "$runtime_root")}/verify.XXXXXX")"
cleanup() {
  find "$temporary" -depth -delete
}
trap cleanup EXIT

(
  cd "$runtime_root"
  find daemon -type f -print | LC_ALL=C sort
) > "$temporary/expected-files"
sed -E 's/^[0-9a-f]{64}  //' "$runtime_root/PAYLOAD.SHA256" \
  | LC_ALL=C sort > "$temporary/listed-files"
cmp "$temporary/expected-files" "$temporary/listed-files"

(
  cd "$runtime_root"
  while IFS= read -r -d '' link; do
    target="$(readlink "$link")"
    hash="$(printf '%s' "$target" | sha256sum | cut -d' ' -f1)"
    printf '%s  %s\n' "$hash" "$link"
  done < <(find daemon -type l -print0 | LC_ALL=C sort -z)
) > "$temporary/symlinks"
cmp "$runtime_root/SYMLINKS.SHA256" "$temporary/symlinks"

(
  cd "$runtime_root"
  while IFS= read -r -d '' path; do
    kind=f
    [[ -d "$path" ]] && kind=d
    [[ -L "$path" ]] && kind=l
    printf '%s\t%s\t%s\n' "$(stat -c '%a' "$path")" "$kind" "$path"
  done < <(find daemon -print0 | LC_ALL=C sort -z)
) > "$temporary/modes"
cmp "$runtime_root/PAYLOAD.MODES" "$temporary/modes"

while IFS= read -r -d '' link; do
  target="$(readlink "$link")"
  if [[ "$target" == /* ]]; then
    resolved="$(realpath -m "$target")"
  else
    resolved="$(realpath -m "$(dirname "$link")/$target")"
  fi
  case "$resolved" in
    "$runtime_root/daemon"/*) ;;
    *)
      printf 'runtime symlink escapes payload: %s -> %s\n' \
        "${link#"$runtime_root/"}" "$resolved" >&2
      exit 1
      ;;
  esac
  [[ -e "$resolved" ]] || {
    printf 'runtime symlink is broken: %s\n' "${link#"$runtime_root/"}" >&2
    exit 1
  }
done < <(find "$runtime_root/daemon" -type l -print0)

bun "$runtime_root/daemon/dist/main.js" --version | grep -Fxq "$version"
printf 'Verified runtime source: %s\n' "$runtime_root"

