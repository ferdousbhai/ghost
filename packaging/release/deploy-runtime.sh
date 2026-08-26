#!/usr/bin/env bash
set -euo pipefail

source_root="${1:?usage: deploy-runtime.sh <source-root> <destination>}"
destination_input="${2:?usage: deploy-runtime.sh <source-root> <destination>}"

source_root="$(realpath "$source_root")"
[[ "$source_root" != *$'\n'* && "$destination_input" != *$'\n'* ]] || {
  printf 'runtime deploy paths must not contain newlines\n' >&2
  exit 1
}
destination="$(realpath -m "$destination_input")"
destination_parent="$(dirname "$destination")"
destination_name="$(basename "$destination")"
work_parent_input="${GHOST_DEPLOY_WORK_ROOT:-$destination_parent}"
[[ "$work_parent_input" != *$'\n'* ]] || {
  printf 'runtime deploy work root must not contain newlines\n' >&2
  exit 1
}
[[ "$destination_name" != . && "$destination_name" != .. \
  && "$destination_name" != / && "$destination_name" != */* ]] || {
  printf 'invalid runtime deploy destination name: %s\n' \
    "$destination_name" >&2
  exit 1
}
case "$destination" in
  "$source_root"|"$source_root"/*)
    printf 'runtime deploy destination must be outside its source: %s\n' \
      "$destination" >&2
    exit 1
    ;;
esac
validate_work_parent() {
  local candidate="$1"

  case "$candidate" in
    "$destination"|"$destination"/*)
      printf 'runtime deploy work root must be outside its destination: %s\n' \
        "$candidate" >&2
      exit 1
      ;;
  esac
}
work_parent="$(realpath -m "$work_parent_input")"
validate_work_parent "$work_parent"
mkdir -p "$destination_parent"
destination_parent="$(realpath "$destination_parent")"
destination="$destination_parent/$destination_name"
case "$destination" in
  "$source_root"|"$source_root"/*)
    printf 'runtime deploy destination must be outside its source: %s\n' \
      "$destination" >&2
    exit 1
    ;;
esac
work_parent="$(realpath -m "$work_parent_input")"
validate_work_parent "$work_parent"

[[ -f "$source_root/package.json" && -f "$source_root/pnpm-lock.yaml" ]] || {
  printf 'runtime deploy source is not a frozen ghost workspace: %s\n' \
    "$source_root" >&2
  exit 1
}
if [[ -e "$destination" || -L "$destination" ]]; then
  printf 'runtime deploy destination already exists: %s\n' "$destination" >&2
  exit 1
fi

if [[ -n "${GHOST_DEPLOY_PNPM:-}" ]]; then
  pnpm_bin="$(realpath "$GHOST_DEPLOY_PNPM")"
else
  pnpm_bin="$(
    cd -- "$source_root"
    env \
      ALL_PROXY=http://127.0.0.1:9 \
      HTTPS_PROXY=http://127.0.0.1:9 \
      HTTP_PROXY=http://127.0.0.1:9 \
      NO_PROXY= \
      all_proxy=http://127.0.0.1:9 \
      https_proxy=http://127.0.0.1:9 \
      http_proxy=http://127.0.0.1:9 \
      no_proxy= \
      pnpm --config.offline=true exec sh -c 'command -v pnpm'
  )"
  pnpm_bin="$(realpath "$pnpm_bin")"
fi
[[ -f "$pnpm_bin" && -x "$pnpm_bin" ]] || {
  printf 'resolved pnpm is not an executable file: %s\n' "$pnpm_bin" >&2
  exit 1
}

required_pnpm="$(bun -e '
  const manifest = await Bun.file(process.argv[1]).json();
  const match = /^pnpm@(.+)$/.exec(manifest.packageManager ?? "");
  if (!match) process.exit(1);
  process.stdout.write(match[1]);
' "$source_root/package.json")"
actual_pnpm="$(npm_config_manage_package_manager_versions=false \
  "$pnpm_bin" --version)"
[[ "$actual_pnpm" == "$required_pnpm" ]] || {
  printf 'runtime deploy requires pnpm %s, resolved %s\n' \
    "$required_pnpm" "$actual_pnpm" >&2
  exit 1
}

if [[ -n "${GHOST_DEPLOY_STORE_PATH:-}" ]]; then
  store_path="$(realpath "$GHOST_DEPLOY_STORE_PATH")"
else
  store_path="$(
    cd -- "$source_root"
    npm_config_manage_package_manager_versions=false "$pnpm_bin" store path
  )"
  store_path="$(realpath "$store_path")"
fi
[[ -d "$store_path" && "$(basename "$store_path")" =~ ^v[0-9]+$ ]] || {
  printf 'pnpm content-addressable store path is invalid: %s\n' \
    "$store_path" >&2
  exit 1
}
store_dir="$(dirname "$store_path")"

mkdir -p "$work_parent"
work_parent="$(realpath "$work_parent")"
validate_work_parent "$work_parent"
if [[ -e "$destination" || -L "$destination" ]]; then
  printf 'runtime deploy destination appeared while preparing work root: %s\n' \
    "$destination" >&2
  exit 1
fi
state=
publish_state=
cleanup() {
  local owned
  for owned in "$state" "$publish_state"; do
    [[ -n "$owned" && -d "$owned" && ! -L "$owned" ]] || continue
    find -P "$owned" -depth -delete
  done
}
trap cleanup EXIT
state="$(mktemp -d "$work_parent/.ghost-pnpm-deploy.XXXXXX")"
chmod 700 "$state"
install -d -m700 "$state/home" "$state/cache" "$state/config" \
  "$state/pnpm-home"
publish_state="$(mktemp -d "$destination_parent/.ghost-pnpm-publish.XXXXXX")"
chmod 700 "$publish_state"
final_destination="$destination"
destination="$publish_state/payload"

(
  cd -- "$source_root"
  # Shared-lock deploy consumes the already-frozen override snapshots. Unlike
  # legacy deploy, it never asks the registry metadata cache to resolve direct
  # dependencies again.
  env \
    HOME="$state/home" \
    XDG_CACHE_HOME="$state/cache" \
    XDG_CONFIG_HOME="$state/config" \
    PNPM_HOME="$state/pnpm-home" \
    npm_config_manage_package_manager_versions=false \
    ALL_PROXY=http://127.0.0.1:9 \
    FTP_PROXY=http://127.0.0.1:9 \
    GLOBAL_AGENT_HTTPS_PROXY=http://127.0.0.1:9 \
    HTTPS_PROXY=http://127.0.0.1:9 \
    HTTP_PROXY=http://127.0.0.1:9 \
    NO_PROXY= \
    all_proxy=http://127.0.0.1:9 \
    ftp_proxy=http://127.0.0.1:9 \
    https_proxy=http://127.0.0.1:9 \
    http_proxy=http://127.0.0.1:9 \
    no_proxy= \
    "$pnpm_bin" \
      --store-dir "$store_dir" \
      --config.ignore-scripts=true \
      --config.inject-workspace-packages=true \
      --config.package-import-method=copy \
      --config.virtual-store-dir-max-length=120 \
      --offline \
      --filter @ghost/daemon \
      --prod \
      deploy "$destination"
)

if find "$state/cache" "$state/pnpm-home" -type f -print -quit | grep -q .; then
  printf 'offline runtime deploy unexpectedly populated package metadata state\n' >&2
  exit 1
fi

pnpm_local_store_name() {
  local package_name="$1"
  local package_path="$2"

  bun -e '
    import { createHash } from "node:crypto";
    import { pathToFileURL } from "node:url";
    let filename = `${process.argv[1]}@${pathToFileURL(process.argv[2]).href}`
      .replace(/[\\/:*?"<>|#]/g, "+");
    if (filename.includes("(")) {
      filename = filename.replace(/\)$/, "").replace(/\)\(|\(|\)/g, "_");
    }
    const maxLength = 120;
    if (filename.length > maxLength ||
        (filename !== filename.toLowerCase() && !filename.startsWith("file+"))) {
      const hash = createHash("sha256").update(filename).digest("hex").slice(0, 32);
      filename = `${filename.slice(0, maxLength - 33)}_${hash}`;
    }
    process.stdout.write(filename);
  ' "$package_name" "$package_path"
}

relocate_workspace_package() {
  local expected_name="$1"
  local canonical_name="$2"
  local virtual_store="$destination/node_modules/.pnpm"
  local canonical="$virtual_store/$canonical_name"
  local package_dir link resolved suffix new_target
  local -a matches=()

  while IFS= read -r -d '' package_dir; do
    matches+=("$package_dir")
  done < <(find "$virtual_store" -mindepth 1 -maxdepth 1 -type d \
    -name "$expected_name" -print0)
  [[ "${#matches[@]}" -eq 1 ]] || {
    printf 'expected one deployed workspace package for %s, found %s\n' \
      "$expected_name" "${#matches[@]}" >&2
    find "$virtual_store" -mindepth 1 -maxdepth 1 -type d -name '*file+*' \
      -printf 'deployed local package: %f\n' >&2
    exit 1
  }
  package_dir="${matches[0]}"
  [[ "$package_dir" != "$canonical" ]] || return 0
  [[ ! -e "$canonical" ]] || {
    printf 'canonical workspace package path already exists: %s\n' \
      "$canonical" >&2
    exit 1
  }

  while IFS= read -r -d '' link; do
    resolved="$(realpath -m "$link")"
    case "$resolved" in
      "$package_dir"|"$package_dir"/*)
        suffix="${resolved#"$package_dir"}"
        new_target="$canonical$suffix"
        unlink "$link"
        ln -s "$(realpath -m --relative-to="$(dirname "$link")" \
          "$new_target")" "$link"
        ;;
    esac
  done < <(find "$destination" -type l -print0)
  mv -- "$package_dir" "$canonical"
}

# Shared-lock deploy names local package directories with absolute file URLs.
# Give the two production workspaces stable names and remove pnpm's install
# metadata, which is neither read by Node/Bun nor part of the runtime payload.
extensions_store_name="$(pnpm_local_store_name '@ghost/extensions' \
  "$source_root/packages/extensions")"
catalog_store_name="$(pnpm_local_store_name '@oh-my-pi/pi-catalog' \
  "$source_root/vendor/pi-catalog")"
relocate_workspace_package "$extensions_store_name" \
  '@ghost+extensions@file+packages+extensions'
relocate_workspace_package "$catalog_store_name" \
  '@oh-my-pi+pi-catalog@file+vendor+pi-catalog'
while IFS= read -r -d '' local_package; do
  case "$(basename "$local_package")" in
    '@ghost+extensions@file+packages+extensions'|\
    '@oh-my-pi+pi-catalog@file+vendor+pi-catalog') ;;
    *)
      printf 'runtime deploy contains an unrecognized local package: %s\n' \
        "$(basename "$local_package")" >&2
      exit 1
      ;;
  esac
done < <(find "$destination/node_modules/.pnpm" -mindepth 1 -maxdepth 1 \
  -type d -name '*file+*' -print0)

# pnpm's generated wrappers live only in `.bin` directories whose immediate
# parent is `node_modules`, and they embed the absolute deploy destination in
# NODE_PATH. Remove precisely those generated directories at every depth.
# A package-owned `assets/.bin` (or any other non-node_modules parent) remains
# ordinary runtime payload.
while IFS= read -r -d '' bin_dir; do
  [[ "$(basename "$(dirname "$bin_dir")")" == node_modules ]] || continue
  find -P "$bin_dir" -depth -delete
done < <(find "$destination/node_modules" -depth -type d -name .bin -print0)

install -m644 "$source_root/packages/daemon/package.json" \
  "$destination/package.json"
for metadata in \
  "$destination/pnpm-lock.yaml" \
  "$destination/node_modules/.modules.yaml" \
  "$destination/node_modules/.pnpm/lock.yaml" \
  "$destination/node_modules/.pnpm-workspace-state.json"; do
  [[ ! -e "$metadata" && ! -L "$metadata" ]] || unlink "$metadata"
done

# pnpm creates some directories and copied files through the caller's umask.
# Normalize only the staged regular payload, retaining whether a file is
# executable while making identical frozen inputs byte-and-mode reproducible.
find "$destination" -type d -exec chmod 755 {} +
find "$destination" -type f -perm /111 -exec chmod 755 {} +
find "$destination" -type f ! -perm /111 -exec chmod 644 {} +

{
  bun -e '
    import { pathToFileURL } from "node:url";
    for (const value of process.argv.slice(1)) {
      console.log(value);
      console.log(value.replace(/[\\/:*?"<>|#]/g, "+"));
      console.log(encodeURIComponent(value));
      console.log(pathToFileURL(value).href);
    }
  ' "$source_root" "$destination" "$final_destination"
  printf '%s\n' "$extensions_store_name" "$catalog_store_name"
} | LC_ALL=C sort -u > "$state/forbidden-build-paths"
while IFS= read -r -d '' path; do
  [[ "$path" != "$destination" ]] || continue
  relative="${path#"$destination"/}"
  while IFS= read -r forbidden; do
    [[ "$relative" != *"$forbidden"* ]] || {
      printf 'runtime deploy retained checkout path in an entry name: %s\n' \
        "$relative" >&2
      exit 1
    }
  done < "$state/forbidden-build-paths"
done < <(find "$destination" -print0)

set +e
LC_ALL=C grep -aFrl -f "$state/forbidden-build-paths" -- \
  "$destination" > "$state/checkout-paths"
path_scan_status=$?
set -e
case "$path_scan_status" in
  0)
    printf 'runtime deploy retained checkout paths:\n' >&2
    sed -n '1,20p' "$state/checkout-paths" >&2
    exit 1
    ;;
  1) ;;
  *)
    printf 'failed to scan runtime deploy for checkout paths\n' >&2
    exit "$path_scan_status"
    ;;
esac

# Publish only a fully validated payload. The staging directory is an owned
# sibling, so this final no-clobber rename is atomic and every earlier failure
# leaves the requested destination absent.
if [[ -e "$final_destination" || -L "$final_destination" ]]; then
  printf 'runtime deploy destination appeared before publication: %s\n' \
    "$final_destination" >&2
  exit 1
fi
mv -Tn -- "$destination" "$final_destination"
if [[ -e "$destination" || -L "$destination" ]]; then
  printf 'runtime deploy could not publish without overwriting: %s\n' \
    "$final_destination" >&2
  exit 1
fi
