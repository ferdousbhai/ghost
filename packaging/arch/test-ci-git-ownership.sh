#!/usr/bin/env bash

# Git rejects a repository owned by another account unless the caller weakens
# its ownership policy. Model the root Actions shell and prove stable-release
# identity reads instead cross the user boundary to the checkout owner.

set -euo pipefail

(( EUID == 0 )) || {
  printf 'builder-owned Git regression must run as root\n' >&2
  exit 1
}

builder="${1:?usage: test-ci-git-ownership.sh <builder-user>}"
[[ "$builder" =~ ^[a-z_][a-z0-9_-]*$ ]] || {
  printf 'invalid builder user: %s\n' "$builder" >&2
  exit 1
}
builder_group="$(id -gn "$builder")"
builder_command=(
  /usr/bin/runuser -u "$builder" -- /usr/bin/env -i
  HOME=/home/builder PATH=/usr/bin TMPDIR=/home/builder
)

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath "$script_dir/../..")"
workflow="$repo_root/.github/workflows/arch-package.yml"
temp_base="${GHOST_CI_GIT_OWNERSHIP_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-ci-git-ownership.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT
chmod 755 "$work"

fixture="$work/builder checkout"
install -d -m755 -o "$builder" -g "$builder_group" "$fixture"
"${builder_command[@]}" git -C "$fixture" init --quiet
"${builder_command[@]}" bash -c \
  'printf "%s\n" builder-owned > "$1/README"' _ "$fixture"
"${builder_command[@]}" git -C "$fixture" add README
"${builder_command[@]}" \
  GIT_AUTHOR_DATE='1700000000 +0000' \
  GIT_COMMITTER_DATE='1700000000 +0000' \
  git -C "$fixture" \
    -c user.name='Ghost packaging test' \
    -c user.email='packaging-test@localhost' \
    commit --quiet -m fixture

# Give root an empty configuration so this proves Git's default ownership
# boundary even on a host whose real root account has unrelated Git settings.
install -d -m700 "$work/root-home" "$work/root-config"
if env \
  GIT_CONFIG_NOSYSTEM=1 \
  HOME="$work/root-home" \
  XDG_CONFIG_HOME="$work/root-config" \
  git -C "$fixture" rev-parse 'HEAD^{commit}' \
    > "$work/root-git.out" 2>&1; then
  printf 'root Git unexpectedly accepted a builder-owned checkout\n' >&2
  exit 1
fi
grep -Fq 'detected dubious ownership' "$work/root-git.out" || {
  printf 'root Git failed for an unexpected reason:\n' >&2
  sed -n '1,20p' "$work/root-git.out" >&2
  exit 1
}

commit="$("${builder_command[@]}" git -C "$fixture" \
  rev-parse 'HEAD^{commit}')"
epoch="$("${builder_command[@]}" git -C "$fixture" \
  show -s --format=%ct "$commit")"
[[ "$commit" =~ ^[0-9a-f]{40}$ && "$epoch" == 1700000000 ]]

# Parse the actual workflow with PyYAML, then bind its complete package job,
# raw block-scalar commands, and post-transfer UID boundaries exactly.
ownership_checker="$script_dir/check-workflow-git-ownership.py"
python "$ownership_checker" "$workflow"
bash "$script_dir/test-workflow-action-pins.sh"
bash "$script_dir/test-native-task-scope-workflow.sh"
bash "$script_dir/test-release-workflow-security.sh"
python "$repo_root/.github/scripts/test-release-draft.py"
python "$repo_root/.github/scripts/test-validate-release-workflow.py"
python - "$workflow" "$work" <<'PY'
from pathlib import Path
import sys

workflow = Path(sys.argv[1])
output = Path(sys.argv[2])
base = workflow.read_text(encoding="utf-8")
stable_name = "      - name: Build and verify stable release sources offline"
stable_exec = (
    "          exec /usr/bin/runuser -u builder -- /usr/bin/env -i "
    "\\"
)
if base.count(stable_name) != 1 or base.count(stable_exec) < 2:
    raise SystemExit("workflow fixture cannot locate stable builder boundary")

def once(old: str, new: str) -> str:
    if base.count(old) != 1:
        raise SystemExit(f"workflow fixture cannot locate {old!r}")
    return base.replace(old, new)

def first(old: str, new: str) -> str:
    if old not in base:
        raise SystemExit(f"workflow fixture cannot locate {old!r}")
    return base.replace(old, new, 1)

def in_stable(old: str, new: str) -> str:
    before, after = base.split(stable_name, 1)
    if after.count(old) < 1:
        raise SystemExit(f"stable fixture cannot locate {old!r}")
    return before + stable_name + after.replace(old, new, 1)

fixtures = {
    "quality-command.yml": once(
        "          uv run --frozen mypy",
        "          uv run mypy",
    ),
    "quality-directory.yml": once(
        "        working-directory: packages/desktop-helper",
        "        working-directory: .",
    ),
    "quality-continue.yml": once(
        "        working-directory: packages/desktop-helper",
        (
            "        working-directory: packages/desktop-helper\n"
            "        continue-on-error: true"
        ),
    ),
    "direct.yml": in_stable(
        stable_exec,
        "          bash packaging/release/ci-build-stable.sh",
    ),
    "mixed-command.yml": in_stable(
        stable_exec,
        stable_exec + '\n          git -C "$GITHUB_WORKSPACE" status',
    ),
    "basename.yml": in_stable(
        stable_exec,
        stable_exec + '\n          /usr/bin/git -C "$GITHUB_WORKSPACE" status',
    ),
    "option-before-c.yml": in_stable(
        stable_exec,
        stable_exec + '\n          git --no-pager -C "$GITHUB_WORKSPACE" status',
    ),
    "alias.yml": in_stable(
        stable_exec,
        stable_exec + "\n          alias inspect=git; inspect -C . status",
    ),
    "eval.yml": in_stable(
        stable_exec,
        stable_exec + "\n          eval 'git -C . status'",
    ),
    "dynamic.yml": in_stable(
        stable_exec,
        stable_exec + '\n          command_name=git; "$command_name" -C . status',
    ),
    "extra-step.yml": once(
        "      - name: Upload sealed public candidate",
        (
            "      - name: Unapproved root shell\n"
            "        run: git -C . status\n\n"
            "      - name: Upload sealed public candidate"
        ),
    ),
    "comment-evasion.yml": in_stable(
        stable_exec,
        stable_exec + " # wrapped\n          git -C . status",
    ),
    "comment-only.yml": in_stable(
        stable_exec,
        "          # git -C is documentation\n" + stable_exec,
    ),
    "folded-style.yml": in_stable("        run: |", "        run: >-"),
    "shell.yml": in_stable("        shell: bash", "        shell: sh"),
    "step-env.yml": in_stable(
        "        shell: bash",
        "        shell: bash\n        env:\n          GITHUB_ENV: /outside",
    ),
    "env-leak.yml": in_stable(
        "/usr/bin/env -i",
        "/usr/bin/env",
    ),
    "working-directory.yml": in_stable(
        "        shell: bash",
        "        shell: bash\n        working-directory: /tmp",
    ),
    "continue.yml": in_stable(
        "        shell: bash",
        "        shell: bash\n        continue-on-error: true",
    ),
    "unknown-key.yml": in_stable(
        "        shell: bash",
        "        shell: bash\n        timeout-minutes: 1",
    ),
    "condition.yml": once(
        "        if: always() && env.GHOST_CI_RELEASE_OUTER != ''",
        "        if: success()",
    ),
    "candidate-seal-disabled.yml": first(
        "        if: vars.GHOST_RELEASE_REPOSITORY != ''",
        "        if: false",
    ),
    "candidate-upload-disabled.yml": once(
        (
            "      - name: Upload sealed public candidate\n"
            "        if: vars.GHOST_RELEASE_REPOSITORY != ''"
        ),
        (
            "      - name: Upload sealed public candidate\n"
            "        if: false"
        ),
    ),
    "candidate-input-authority.yml": first(
        "        if: vars.GHOST_RELEASE_REPOSITORY != ''",
        "        if: inputs.destination_repository != ''",
    ),
    "stable-optional.yml": once(
        stable_name,
        stable_name + "\n        if: vars.GHOST_RELEASE_REPOSITORY != ''",
    ),
    "uses-ref.yml": once(
        "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
        "actions/checkout@main",
    ),
    "with.yml": once("          fetch-depth: 0", "          fetch-depth: 1"),
    "artifact-attempt.yml": once(
        "          name: ghost-public-candidate-${{ github.sha }}-${{ github.run_attempt }}",
        "          name: ghost-public-candidate-${{ github.sha }}-1",
    ),
    "job-env.yml": once(
        "    container: archlinux:base-devel",
        "    container: archlinux:base-devel\n    env:\n      GITHUB_ENV: /outside",
    ),
    "job-defaults.yml": once(
        "    container: archlinux:base-devel",
        (
            "    container: archlinux:base-devel\n"
            "    defaults:\n      run:\n        shell: sh"
        ),
    ),
    "duplicate-key.yml": in_stable(
        "        shell: bash",
        "        shell: bash\n        shell: sh",
    ),
    "anchor.yml": in_stable(
        "        shell: bash",
        "        shell: &unsafe bash",
    ),
    "order.yml": base.replace(
        "      - name: Upload sealed public candidate",
        "      - name: __SECOND__",
    ).replace(
        "      - name: Remove trusted release outer",
        "      - name: Upload sealed public candidate",
    ).replace(
        "      - name: __SECOND__",
        "      - name: Remove trusted release outer",
    ),
    "release-trigger.yml": once(
        "on:\n  pull_request:",
        "on:\n  release:\n    types: [published]\n  pull_request:",
    ),
    "branch-trigger.yml": once("    branches: [master]", "    branches: [topic]"),
    "tag-trigger.yml": once(
        "    branches: [master]",
        "    branches: [master]\n    tags: ['v*']",
    ),
    "write-permission.yml": once("  contents: read", "  contents: write"),
    "release-job.yml": base + "\n  release:\n    runs-on: ubuntu-latest\n    steps: []\n",
}
package_start = base.index("  package:")
package_end = len(base)
approved_decoy = base[package_start:package_end]
real_direct = in_stable(
    stable_exec,
    "          /usr/bin/bash packaging/release/ci-build-stable.sh",
)
fixtures["literal-decoy.yml"] = real_direct.replace(
    "name: Arch package",
    "name: |\n" + "".join("  " + line for line in approved_decoy.splitlines(True)),
    1,
)
for name, text in fixtures.items():
    if text == base:
        raise SystemExit(f"workflow fixture did not mutate {name}")
    (output / name).write_text(text, encoding="utf-8")
PY

for invalid in \
  quality-command.yml quality-directory.yml quality-continue.yml \
  direct.yml mixed-command.yml basename.yml option-before-c.yml \
  alias.yml eval.yml dynamic.yml extra-step.yml comment-evasion.yml \
  comment-only.yml folded-style.yml shell.yml step-env.yml \
  env-leak.yml working-directory.yml continue.yml uses-ref.yml with.yml job-env.yml \
  artifact-attempt.yml \
  job-defaults.yml duplicate-key.yml anchor.yml unknown-key.yml condition.yml \
  candidate-seal-disabled.yml candidate-upload-disabled.yml \
  candidate-input-authority.yml stable-optional.yml \
  order.yml release-trigger.yml branch-trigger.yml tag-trigger.yml \
  write-permission.yml release-job.yml literal-decoy.yml; do
  if python "$ownership_checker" "$work/$invalid" > /dev/null 2>&1; then
    printf 'workflow ownership parser accepted adversarial fixture: %s\n' \
      "$invalid" >&2
    exit 1
  fi
done

printf 'builder-owned stable Git access passed\n'
