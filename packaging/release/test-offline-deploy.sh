#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: test-offline-deploy.sh <source-root>}"
source_root="$(realpath "$source_root")"
test_parent="${GHOST_OFFLINE_DEPLOY_TEST_ROOT:-$(dirname "$source_root")}"
mkdir -p "$test_parent"
test_parent="$(realpath "$test_parent")"
work="$(mktemp -d "$test_parent/ghost-offline-deploy.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

pnpm_bin="$(
  cd -- "$source_root"
  pnpm exec sh -c 'command -v pnpm'
)"
pnpm_bin="$(realpath "$pnpm_bin")"
source_store_path="$(
  cd -- "$source_root"
  npm_config_manage_package_manager_versions=false "$pnpm_bin" store path
)"
source_store_path="$(realpath "$source_store_path")"
fresh_store_dir="$work/store"
fresh_store_path="$fresh_store_dir/$(basename "$source_store_path")"
install -d -m700 "$fresh_store_path"

# Give both deploys a genuinely new store path without duplicating the large
# frozen payload. Deploy reads this store, so hard links preserve byte identity
# while keeping the regression practical in package checks.
cp -al -- "$source_store_path/." "$fresh_store_path/"
[[ "$(realpath "$fresh_store_path")" != "$source_store_path" ]]

long_a="$(printf 'a%.0s' {1..72})"
long_b="$(printf 'b%.0s' {1..79})"
checkout_a="$work/checkouts/source A #one,comma,/$long_a/source"
checkout_b="$work/checkouts/source B #two,comma,/at/a/different/depth/$long_b/source"
destination_a="$work/outputs/runtime A #one,colon:/daemon"
destination_b="$work/outputs/runtime B #two,colon:/at/a/different/depth/daemon"

copy_checkout() {
  local destination="$1"
  mkdir -p "$destination"
  (
    cd -- "$source_root"
    mapfile -d '' manifests < <(
      find packages -mindepth 2 -maxdepth 2 -type f -name package.json \
        -print0 | LC_ALL=C sort -z
    )
    tar -cf - \
      package.json pnpm-lock.yaml pnpm-workspace.yaml \
      patches \
      "${manifests[@]}" \
      packages/daemon/dist packages/daemon/contrib packages/daemon/README.md \
      packages/extensions/dist \
      vendor/pi-catalog/package.json \
      vendor/pi-catalog/src vendor/pi-catalog/dist/types \
      vendor/pi-catalog/README.md vendor/pi-catalog/CHANGELOG.md \
      vendor/pi-catalog/LICENSE vendor/pi-catalog/THIRD-PARTY-NOTICES.txt
  ) | tar -C "$destination" -xf -
  install -d -m750 "$destination/packages/daemon/dist/assets/.bin"
  printf 'package-owned nested dot-bin fixture\n' \
    > "$destination/packages/daemon/dist/assets/.bin/sentinel"
  chmod 640 "$destination/packages/daemon/dist/assets/.bin/sentinel"
}

assert_closed_links() {
  local daemon="$1"
  local link resolved
  while IFS= read -r -d '' link; do
    resolved="$(realpath -m "$link")"
    case "$resolved" in
      "$daemon"/*) ;;
      *)
        printf 'offline deploy symlink escapes payload: %s -> %s\n' \
          "${link#"$daemon"/}" "$resolved" >&2
        exit 1
        ;;
    esac
    [[ -e "$resolved" ]] || {
      printf 'offline deploy symlink is broken: %s\n' \
        "${link#"$daemon"/}" >&2
      exit 1
    }
  done < <(find "$daemon" -type l -print0)
}

assert_no_path_references() {
  local daemon="$1"
  shift
  local needle sanitized percent_encoded file_url path relative status
  for needle in "$@"; do
    sanitized="$(bun -e '
      process.stdout.write(process.argv[1].replace(/[\\/:*?"<>|#]/g, "+"));
    ' "$needle")"
    percent_encoded="$(bun -e '
      process.stdout.write(encodeURIComponent(process.argv[1]));
    ' "$needle")"
    file_url="$(bun -e '
      import { pathToFileURL } from "node:url";
      process.stdout.write(pathToFileURL(process.argv[1]).href);
    ' "$needle")"
    while IFS= read -r -d '' path; do
      [[ "$path" != "$daemon" ]] || continue
      relative="${path#"$daemon"/}"
      case "$relative" in
        *"$needle"*|*"$sanitized"*|*"$percent_encoded"*|*"$file_url"*)
          printf 'deploy entry name retained an absolute build path: %s\n' \
            "$relative" >&2
          exit 1
          ;;
      esac
    done < <(find "$daemon" -print0)

    set +e
    printf '%s\n%s\n%s\n%s\n' \
      "$needle" "$sanitized" "$percent_encoded" "$file_url" \
      > "$work/path-patterns"
    grep -aFrl -f "$work/path-patterns" -- "$daemon" \
      > "$work/path-references"
    status=$?
    set -e
    case "$status" in
      0)
        printf 'deploy contents retained absolute build path %s:\n' \
          "$needle" >&2
        sed -n '1,20p' "$work/path-references" >&2
        exit 1
        ;;
      1) ;;
      *) exit "$status" ;;
    esac
  done
}

write_inventory() {
  local daemon="$1"
  local output="$2"
  (
    cd -- "$daemon"
    if find . -mindepth 1 ! \( -type f -o -type d -o -type l \) \
      -print -quit | grep -q .; then
      printf 'offline deploy contains a special entry\n' >&2
      exit 1
    fi
    find . -mindepth 1 -type d -printf 'd %m %P\0' | LC_ALL=C sort -z
    find . -mindepth 1 -type l -printf 'l %m %P -> %l\0' | LC_ALL=C sort -z
    find . -mindepth 1 -type f -printf 'f %m %P\0' | LC_ALL=C sort -z
    find . -mindepth 1 -type f -print0 | LC_ALL=C sort -z \
      | xargs -0 -r sha256sum -z
  ) > "$output"
}

run_deploy() {
  local checkout="$1"
  local destination="$2"
  local deploy_umask="$3"
  (
    umask "$deploy_umask"
    GHOST_DEPLOY_STORE_PATH="$fresh_store_path" \
    GHOST_DEPLOY_WORK_ROOT="$work" \
      bash "$source_root/packaging/release/deploy-runtime.sh" \
        "$checkout" "$destination"
  )

  [[ -f "$destination/dist/main.js" ]]
  [[ -f "$destination/node_modules/@anthropic-ai/claude-agent-sdk/package.json" ]]
  [[ -f "$destination/node_modules/@ghost/extensions/package.json" ]]
  [[ -f "$destination/node_modules/.pnpm/node_modules/@oh-my-pi/pi-catalog/package.json" ]]
  while IFS= read -r -d '' bin_dir; do
    [[ "$(basename "$(dirname "$bin_dir")")" != node_modules ]] || {
      printf 'offline deploy retained a pnpm-generated wrapper directory: %s\n' \
        "${bin_dir#"$destination"/}" >&2
      exit 1
    }
  done < <(find "$destination" -type d -name .bin -print0)
  [[ "$(< "$destination/dist/assets/.bin/sentinel")" == \
    'package-owned nested dot-bin fixture' ]]
  assert_closed_links "$destination"
  assert_no_path_references "$destination" \
    "$checkout_a" "$checkout_b" "$destination_a" "$destination_b"
}

assert_no_helper_residue() {
  if find "$work" -type d \( \
    -name '.ghost-pnpm-deploy.*' -o \
    -name '.ghost-pnpm-publish.*' \
  \) -print -quit | grep -q .; then
    printf 'offline deploy left helper-owned work after rejection\n' >&2
    exit 1
  fi
}

assert_rejected_work_root() {
  local invalid_work_root="$1"

  if GHOST_DEPLOY_STORE_PATH="$fresh_store_path" \
    GHOST_DEPLOY_WORK_ROOT="$invalid_work_root" \
      bash "$source_root/packaging/release/deploy-runtime.sh" \
        "$checkout_a" "$destination_a"; then
    printf 'offline deploy accepted work root under its destination: %s\n' \
      "$invalid_work_root" >&2
    exit 1
  fi
  [[ ! -e "$destination_a" && ! -L "$destination_a" ]]
  assert_no_helper_residue
}

copy_checkout "$checkout_a"
copy_checkout "$checkout_b"

# Dependency patches are frozen release inputs in their own right. Prove a
# patch-only byte change invalidates the exact manifest input set, then restore
# the checkout before exercising the offline deploy.
patch_path="$checkout_a/patches/@oh-my-pi__pi-coding-agent@18.0.3.patch"
patch_backup="$work/patch.backup"
cp -- "$patch_path" "$patch_backup"
patch_digest_before="$(
  bash "$source_root/packaging/release/frozen-inputs.sh" "$checkout_a" \
    | sha256sum | cut -d' ' -f1
)"
printf '\n# frozen-input digest regression fixture\n' >> "$patch_path"
patch_digest_after="$(
  bash "$source_root/packaging/release/frozen-inputs.sh" "$checkout_a" \
    | sha256sum | cut -d' ' -f1
)"
[[ "$patch_digest_before" != "$patch_digest_after" ]] || {
  printf 'dependency patch-only change did not alter the frozen input digest\n' >&2
  exit 1
}
cp -- "$patch_backup" "$patch_path"
cmp -- "$patch_backup" "$patch_path"

# Work state can never be the requested final destination or live beneath it:
# either choice would let a later cleanup erase the published payload. Both
# rejections are side-effect free, and the same final target remains reusable.
assert_rejected_work_root "$destination_a"
assert_rejected_work_root "$destination_a/work"
run_deploy "$checkout_a" "$destination_a" 022
mv -- "$checkout_a" "$checkout_a.hidden"
bun "$destination_a/dist/main.js" --version
write_inventory "$destination_a" "$work/inventory-a"
find -P "$destination_a" -depth -delete
find -P "$checkout_a.hidden" -depth -delete

run_deploy "$checkout_b" "$destination_b" 077
mv -- "$checkout_b" "$checkout_b.hidden"
bun "$destination_b/dist/main.js" --version
write_inventory "$destination_b" "$work/inventory-b"
if ! cmp "$work/inventory-a" "$work/inventory-b"; then
  tr '\0' '\n' < "$work/inventory-a" > "$work/inventory-a.txt"
  tr '\0' '\n' < "$work/inventory-b" > "$work/inventory-b.txt"
  diff -u "$work/inventory-a.txt" "$work/inventory-b.txt" | sed -n '1,120p' >&2
  exit 1
fi

# A failure after pnpm assembled its payload must clean only the owned sibling
# staging directory and leave both the requested destination and outside data
# untouched. A raw checkout path in a package-owned file triggers the final
# checkout-path validation without a production-only test hook.
failure_checkout="$work/checkouts/failure source #,comma,/source"
failure_destination="$work/outputs/failure destination #,colon:/daemon"
copy_checkout "$failure_checkout"
printf '%s\n' "$failure_checkout" \
  > "$failure_checkout/packages/daemon/dist/assets/checkout-path"
outside_sentinel="$work/outside-sentinel"
printf 'outside\n' > "$outside_sentinel"
if GHOST_DEPLOY_STORE_PATH="$fresh_store_path" \
  GHOST_DEPLOY_WORK_ROOT="$work" \
    bash "$source_root/packaging/release/deploy-runtime.sh" \
      "$failure_checkout" "$failure_destination"; then
  printf 'offline deploy unexpectedly published a rejected payload\n' >&2
  exit 1
fi
[[ ! -e "$failure_destination" && ! -L "$failure_destination" ]]
[[ "$(< "$outside_sentinel")" == outside ]]
if find "$(dirname "$failure_destination")" -mindepth 1 -maxdepth 1 \
  -name '.ghost-pnpm-publish.*' -print -quit | grep -q .; then
  printf 'offline deploy left a sibling staging directory after failure\n' >&2
  exit 1
fi

if GHOST_DEPLOY_STORE_PATH="$fresh_store_path" \
  GHOST_DEPLOY_WORK_ROOT="$work" \
    bash "$source_root/packaging/release/deploy-runtime.sh" \
      "$checkout_b.hidden" "$checkout_b.hidden"; then
  printf 'offline deploy accepted a destination equal to its source\n' >&2
  exit 1
fi
nested_destination="$checkout_b.hidden/runtime"
if GHOST_DEPLOY_STORE_PATH="$fresh_store_path" \
  GHOST_DEPLOY_WORK_ROOT="$work" \
    bash "$source_root/packaging/release/deploy-runtime.sh" \
      "$checkout_b.hidden" "$nested_destination"; then
  printf 'offline deploy accepted a destination nested in its source\n' >&2
  exit 1
fi
[[ ! -e "$nested_destination" && ! -L "$nested_destination" ]]
[[ "$(< "$outside_sentinel")" == outside ]]

# The development package invokes this exact deploy helper. The stable package
# consumes the runtime archive produced through runtime-tree -> deploy helper;
# render it once here to keep that call chain and artifact source explicit.
grep -Fq 'bash packaging/release/deploy-runtime.sh . "$appdir/daemon"' \
  "$source_root/packaging/arch/PKGBUILD"
grep -Fq 'bash packaging/release/deploy-runtime.sh "$source_root" "$destination"' \
  "$source_root/packaging/release/runtime-tree.sh"
rendered="$work/rendered-stable"
bash "$source_root/packaging/release/render-arch-package.sh" \
  "$rendered" 0.0.1 \
  0000000000000000000000000000000000000000 1 \
  0000000000000000000000000000000000000000000000000000000000000000 \
  0000000000000000000000000000000000000000000000000000000000000000
grep -Fq '_runtime="ghost-runtime-${pkgver}-linux-${CARCH}.tar.zst"' \
  "$rendered/PKGBUILD"
grep -Fq 'bash "$source_root/packaging/release/install-payload.sh"' \
  "$rendered/PKGBUILD"

printf 'Frozen offline daemon deploy is path-independent with an empty metadata cache\n'
