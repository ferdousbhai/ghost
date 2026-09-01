#!/usr/bin/env bash

# Keep commands used by package checks, PKGBUILD metadata, generated .SRCINFO,
# and the CI dependency installer in agreement.

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
source_root="$(realpath -e -- "$script_dir/../..")"
temp_base="${GHOST_ARCH_DEPENDENCY_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-arch-dependencies.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

if (( EUID == 0 )); then
  printf 'package metadata parity must run as the unprivileged builder\n' >&2
  exit 1
fi

require_srcinfo_entry() {
  local field="$1"
  local package="$2"
  local srcinfo="$3"
  if ! grep -Fxq $'\t'"$field = $package" "$srcinfo"; then
    printf '%s does not declare %s = %s\n' "$srcinfo" "$field" "$package" >&2
    exit 1
  fi
}

require_srcinfo_dependency() {
  local package="$1"
  local srcinfo="$2"
  if ! grep -Eq $'^\tdepends = '"${package}([<>=]|\$)" "$srcinfo"; then
    printf '%s does not declare depends = %s\n' "$srcinfo" "$package" >&2
    exit 1
  fi
}

require_obsidian_readiness_before_service() {
  local install_script="$1"
  local hook="$2"
  local service_command="$3"
  local output setup_line service_line
  output="$(bash -c 'source "$1"; "$2"' ghost-install-hook "$install_script" "$hook")"
  for expected in \
    'npx -y skills@latest add https://github.com/kepano/obsidian-skills' \
    'obsidian version' \
    'test -f ~/.agents/skills/obsidian-cli/SKILL.md' \
    "$service_command"; do
    if ! grep -Fq -- "$expected" <<< "$output"; then
      printf '%s %s does not print %s\n' "$install_script" "$hook" "$expected" >&2
      exit 1
    fi
  done
  setup_line="$(grep -nF -m1 -- 'obsidian version' <<< "$output" | cut -d: -f1)"
  service_line="$(grep -nF -m1 -- "$service_command" <<< "$output" | cut -d: -f1)"
  if (( setup_line >= service_line )); then
    printf '%s %s prints service activation before Obsidian readiness\n' \
      "$install_script" "$hook" >&2
    exit 1
  fi
}

command -v rg >/dev/null || {
  printf 'ripgrep is required by pi grep and package checks but is not installed\n' >&2
  exit 1
}
command -v fd >/dev/null || {
  printf 'fd is required by pi find but is not installed\n' >&2
  exit 1
}
command -v node >/dev/null || {
  printf 'nodejs is required by package checks but is not installed\n' >&2
  exit 1
}
command -v jq >/dev/null || {
  printf 'jq is required by the Omarchy contribution regression but is not installed\n' >&2
  exit 1
}
python -c 'import yaml' >/dev/null 2>&1 || {
  printf 'python-yaml is required by package checks but is not installed\n' >&2
  exit 1
}

for install_script in \
  "$script_dir/ghost-dev.install" \
  "$source_root/packaging/omarchy/pkgbuilds/ghost/ghost.install"; do
  require_obsidian_readiness_before_service "$install_script" post_install \
    'systemctl --user enable --now ghostd.service ghost-shell.service'
  require_obsidian_readiness_before_service "$install_script" post_upgrade \
    'systemctl --user reenable --now ghostd.service ghost-shell.service'
done

bash "$script_dir/test-ci-dependencies.sh"
bash "$script_dir/test-accept-obsidian.sh"
bash "$source_root/packaging/release/test-release-version.sh"
bash "$source_root/packaging/release/test-minimum-bun-smoke.sh"
python "$source_root/packaging/release/test-public-candidate.py"
python "$script_dir/test-seal-regular-inputs.py"
bash "$source_root/packaging/omarchy/test-contribution.sh"

# Every packaging test suite must be invoked by some other packaging or CI
# file; an unreferenced test-* file is a suite that silently never runs.
while IFS= read -r suite; do
  name="$(basename -- "$suite")"
  if ! grep -rFq --exclude="$name" --exclude-dir=__pycache__ \
    --exclude='README.md' "$name" \
    "$source_root/packaging" "$source_root/.github"; then
    printf 'orphaned packaging test suite: %s is referenced nowhere\n' \
      "$suite" >&2
    exit 1
  fi
done < <(find "$source_root/packaging" "$source_root/.github/scripts" \
  -name __pycache__ -prune \
  -o -name 'test-*' -type f -print | sort)

rg -q 'rg[[:space:]]+-l' \
  "$source_root/packages/shell/dev/test.sh"
rg -q '"test"[[:space:]]*:[[:space:]]*"node --test' \
  "$source_root/packages/chromium-extension/package.json"

(
  CDPATH= cd -- "$script_dir"
  env -u GHOST_SOURCE_REPO -u GHOST_SOURCE_REF makepkg --printsrcinfo
) > "$work/ghost-dev.SRCINFO"
cmp "$script_dir/.SRCINFO" "$work/ghost-dev.SRCINFO"
require_srcinfo_entry checkdepends jq "$work/ghost-dev.SRCINFO"
require_srcinfo_entry checkdepends nodejs "$work/ghost-dev.SRCINFO"
require_srcinfo_entry checkdepends python-yaml "$work/ghost-dev.SRCINFO"
require_srcinfo_entry makedepends 'bun>=1.4.0' "$work/ghost-dev.SRCINFO"
require_srcinfo_entry optdepends \
  'claude-code>=2.1.251: owner-installed Claude Code harness runtime' \
  "$work/ghost-dev.SRCINFO"
require_srcinfo_dependency bun "$work/ghost-dev.SRCINFO"
# The keyring store shells out to libsecret's secret-tool at runtime.
require_srcinfo_dependency libsecret "$work/ghost-dev.SRCINFO"
require_srcinfo_dependency npm "$work/ghost-dev.SRCINFO"
require_srcinfo_dependency obsidian "$work/ghost-dev.SRCINFO"
# pi otherwise downloads these into its cache on the first grep/find call.
require_srcinfo_dependency fd "$work/ghost-dev.SRCINFO"
require_srcinfo_dependency ripgrep "$work/ghost-dev.SRCINFO"
require_srcinfo_entry depends 'systemd>=254' "$work/ghost-dev.SRCINFO"

GHOST_RELEASE_REPOSITORY=example/ghost-releases \
  bash "$source_root/packaging/release/render-arch-package.sh" \
  "$work/ghost" \
  0.0.1 \
  0000000000000000000000000000000000000000000000000000000000000000 \
  0000000000000000000000000000000000000000000000000000000000000000
require_srcinfo_entry checkdepends jq "$work/ghost/.SRCINFO"
require_srcinfo_entry checkdepends nodejs "$work/ghost/.SRCINFO"
require_srcinfo_entry checkdepends python-yaml "$work/ghost/.SRCINFO"
require_srcinfo_entry makedepends 'bun>=1.4.0' "$work/ghost/.SRCINFO"
require_srcinfo_entry optdepends \
  'claude-code>=2.1.251: owner-installed Claude Code harness runtime' \
  "$work/ghost/.SRCINFO"
require_srcinfo_dependency bun "$work/ghost/.SRCINFO"
require_srcinfo_dependency libsecret "$work/ghost/.SRCINFO"
require_srcinfo_dependency npm "$work/ghost/.SRCINFO"
require_srcinfo_dependency obsidian "$work/ghost/.SRCINFO"
require_srcinfo_dependency fd "$work/ghost/.SRCINFO"
require_srcinfo_dependency ripgrep "$work/ghost/.SRCINFO"
require_srcinfo_entry depends 'systemd>=254' "$work/ghost/.SRCINFO"
sed -n 's/^	depends = //p' "$work/ghost-dev.SRCINFO" \
  | LC_ALL=C sort > "$work/development-depends"
sed -n 's/^	depends = //p' "$work/ghost/.SRCINFO" \
  | LC_ALL=C sort > "$work/stable-depends"
if ! cmp "$work/development-depends" "$work/stable-depends"; then
  printf 'stable and development runtime dependencies differ\n' >&2
  exit 1
fi

ci_dependencies_file="$work/ci-dependencies"
bash "$script_dir/ci-dependencies.sh" --names > "$ci_dependencies_file"
mapfile -t ci_dependencies < "$ci_dependencies_file"
for package in bun fd jq nodejs python-yaml ripgrep; do
  if [[ ! " ${ci_dependencies[*]} " =~ [[:space:]]${package}[[:space:]] ]]; then
    printf 'CI dependency set does not contain %s\n' "$package" >&2
    exit 1
  fi
done

printf 'Arch package check dependency coverage passed\n'
