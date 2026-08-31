#!/usr/bin/env bash

# Keep publication manual, draft-first, non-overwriting, and credential-late.

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath "$script_dir/../..")"
workflow="$repo_root/.github/workflows/release.yml"
checker="$script_dir/check-release-workflow-security.py"
temp_base="${GHOST_CI_RELEASE_WORKFLOW_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-release-workflow.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

python "$checker" "$workflow"
python - "$workflow" "$work" <<'PY'
from pathlib import Path
import sys

source = Path(sys.argv[1]).read_text(encoding="utf-8")
output = Path(sys.argv[2])


def once(text: str, old: str, new: str) -> str:
    if text.count(old) != 1:
        raise SystemExit(f"fixture cannot locate unique text: {old!r}")
    return text.replace(old, new)


def first(text: str, old: str, new: str) -> str:
    if old not in text:
        raise SystemExit(f"fixture cannot locate text: {old!r}")
    return text.replace(old, new, 1)


reconfirm_start = source.index(
    "      - name: Reconfirm trusted protected master after environment admission\n"
)
reconfirm_end = source.index(
    "      - name: Mint least-privilege publication token\n",
    reconfirm_start,
)
reconfirm_block = source[reconfirm_start:reconfirm_end]
preflight_marker = "      - name: Preflight public repository and immutable releases\n"


fixtures = {
    "automatic-trigger.yml": once(
        source,
        "on:\n  workflow_dispatch:",
        "on:\n  release:\n    types: [published]\n  workflow_dispatch:",
    ),
    "write-token.yml": once(source, "  contents: read", "  contents: write"),
    "cancel.yml": once(source, "  cancel-in-progress: false", "  cancel-in-progress: true"),
    "version-concurrency.yml": once(
        source,
        "  group: ghost-public-release",
        "  group: ghost-release-${{ inputs.version }}",
    ),
    "destination-default.yml": once(
        source,
        "      destination_repository:\n        description:",
        "      destination_repository:\n        default: owner/repo\n        description:",
    ),
    "environment-destination.yml": once(
        source,
        "          CONFIGURED_REPOSITORY: ${{ needs.candidate.outputs.destination }}",
        "          CONFIGURED_REPOSITORY: ${{ vars.GHOST_RELEASE_REPOSITORY }}",
    ),
    "input-only-destination.yml": once(
        source,
        "          CONFIGURED_REPOSITORY: ${{ vars.GHOST_RELEASE_REPOSITORY }}",
        "          CONFIGURED_REPOSITORY: ${{ inputs.destination_repository }}",
    ),
    "optional-destination.yml": once(
        source,
        "          CONFIGURED_REPOSITORY: ${{ vars.GHOST_RELEASE_REPOSITORY }}",
        (
            "          CONFIGURED_REPOSITORY: "
            "${{ vars.GHOST_RELEASE_REPOSITORY || inputs.destination_repository }}"
        ),
    ),
    "unprotected.yml": once(
        source,
        "    environment: public-release",
        "    environment: unprotected",
    ),
    "extra-permission.yml": once(
        source,
        "    environment: public-release",
        "    environment: public-release\n    permissions:\n      contents: write",
    ),
    "broader-app.yml": once(
        source,
        "          permission-contents: write",
        "          permission-contents: write\n          permission-issues: write",
    ),
    "no-administration-preflight.yml": once(
        source,
        "          permission-administration: read\n",
        "",
    ),
    "clobber.yml": once(
        source,
        (
            "            --github-output \"$GITHUB_OUTPUT\"\n\n"
            "      - name: Publish exact staged draft"
        ),
        (
            "            --github-output \"$GITHUB_OUTPUT\" --clobber\n\n"
            "      - name: Publish exact staged draft"
        ),
    ),
    "stage-publishes.yml": once(
        source,
        "        if: inputs.mode == 'stage'\n        env:\n          GH_TOKEN:",
        "        if: inputs.mode == 'publish'\n        env:\n          GH_TOKEN:",
    ),
    "publish-stages.yml": once(
        source,
        "        if: inputs.mode == 'publish'\n        env:\n          GH_TOKEN:",
        "        if: inputs.mode == 'stage'\n        env:\n          GH_TOKEN:",
    ),
    "candidate-secret.yml": once(
        source,
        "          MODE: ${{ inputs.mode }}",
        "          MODE: ${{ inputs.mode }}\n          PRIVATE_KEY: ${{ secrets.KEY }}",
    ),
    "dispatch-branch.yml": once(
        source,
        "github.ref == 'refs/heads/master'",
        "github.ref == 'refs/heads/topic'",
    ),
    "untrusted-orchestration-checkout.yml": once(
        source,
        "          ref: ${{ github.workflow_sha }}\n"
        "          fetch-depth: 1\n"
        "          path: orchestration",
        "          ref: ${{ inputs.source_sha }}\n"
        "          fetch-depth: 1\n"
        "          path: orchestration",
    ),
    "candidate-executes-helper.yml": once(
        source,
        "python orchestration/.github/scripts/validate-release-workflow.py inputs",
        "python source/.github/scripts/validate-release-workflow.py inputs",
    ),
    "python-cache.yml": first(
        source,
        "          python-version: '3.14'",
        "          python-version: '3.14'\n          cache: pip",
    ),
    "python-version.yml": first(
        source,
        "          python-version: '3.14'",
        "          python-version: '3.13'",
    ),
    "private-key-validator.yml": once(
        source,
        "          MODE: ${{ inputs.mode }}",
        "          MODE: ${{ inputs.mode }}\n"
        "          APP_KEY: ${{ secrets.GHOST_RELEASE_APP_PRIVATE_KEY }}",
    ),
    "candidate-download-attempt.yml": once(
        source,
        (
            "          name: ghost-public-candidate-${{ inputs.source_sha }}-"
            "${{ steps.source-run.outputs.run_attempt }}"
        ),
        "          name: ghost-public-candidate-${{ inputs.source_sha }}-1",
    ),
    "publication-download-attempt.yml": once(
        source,
        (
            "          name: ghost-public-candidate-${{ inputs.source_sha }}-"
            "${{ needs.candidate.outputs.run_attempt }}"
        ),
        "          name: ghost-public-candidate-${{ inputs.source_sha }}-1",
    ),
    "missing-accepted-commit.yml": once(
        source,
        '            --accepted-candidate-commit "$ACCEPTED_CANDIDATE_COMMIT"\n',
        "",
    ),
    "missing-immutable-preflight.yml": once(
        source,
        "release-draft.py preflight",
        "release-draft.py verify-local",
    ),
    "missing-publication-trust-recheck.yml": once(source, reconfirm_block, ""),
    "late-publication-trust-recheck.yml": once(
        once(source, reconfirm_block, ""),
        preflight_marker,
        reconfirm_block + preflight_marker,
    ),
    "weak-publication-trust-recheck.yml": once(
        source,
        reconfirm_block,
        reconfirm_block.replace(
            '--workflow-sha "$TRUSTED_SHA"',
            '--workflow-sha "${{ inputs.source_sha }}"',
        ),
    ),
    "raw-drift.yml": once(
        source,
        "name: Release candidate",
        "name: Release candidate changed",
    ),
}
for name, text in fixtures.items():
    if text == source:
        raise SystemExit(f"fixture did not mutate workflow: {name}")
    (output / name).write_text(text, encoding="utf-8")
PY

for invalid in "$work"/*.yml; do
  if python "$checker" "$invalid" > /dev/null 2>&1; then
    printf 'release workflow checker accepted adversarial fixture: %s\n' \
      "$(basename "$invalid")" >&2
    exit 1
  fi
done

printf 'manual release workflow security fixtures passed\n'
