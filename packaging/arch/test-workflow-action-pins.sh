#!/usr/bin/env bash

# Keep remote actions immutable, including dependencies of local composites.

set -euo pipefail

script_dir="$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(realpath "$script_dir/../..")"
checker="$script_dir/check-workflow-action-pins.py"
temp_base="${GHOST_CI_ACTION_PIN_TEST_ROOT:-${TMPDIR:-/tmp}}"
mkdir -p "$temp_base"
work="$(mktemp -d "$temp_base/ghost-ci-action-pins.XXXXXX")"
cleanup() {
  find -P "$work" -depth -delete
}
trap cleanup EXIT

python "$checker" "$repo_root"
python - "$work" <<'PY'
from pathlib import Path
import sys

root = Path(sys.argv[1])
sha = "0123456789abcdef0123456789abcdef01234567"
digest = "0123456789abcdef" * 4


def write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def workflow(repository: Path, steps: str) -> None:
    write(
        repository / ".github/workflows/check.yml",
        f"jobs:\n  check:\n    steps:\n{steps}",
    )


valid = root / "valid"
write(
    valid / ".github/workflows/check.yml",
    f"""\
env:
  uses: owner/ignored@main
jobs:
  check:
    steps:
      - uses: owner/action@{sha}
        with:
          uses: owner/ignored@v4
        env:
          uses: owner/ignored@main
      - uses: docker://alpine@sha256:{digest}
      - uses: $/.github/actions/first
      - uses: ./.github/actions/second
      - parallel:
          - uses: owner/action@{sha}
          - uses: docker://alpine@sha256:{digest}
          - parallel:
              - uses: $/.github/actions/second
  reusable:
    uses: $/.github/workflows/reusable.yaml
""",
)
write(
    valid / ".github/workflows/reusable.yaml",
    f"jobs:\n  check:\n    steps:\n      - uses: owner/action@{sha}\n",
)
write(
    valid / ".github/actions/first/action.yml",
    f"""\
runs:
  using: composite
  steps:
    - uses: owner/action@{sha}
      with:
        uses: owner/ignored@v4
    - uses: $/.github/actions/second
    - parallel:
        - uses: owner/ignored@v4
""",
)
write(
    valid / ".github/actions/second/action.yaml",
    f"""\
runs:
  using: composite
  steps:
    - uses: docker://alpine@sha256:{digest}
""",
)

invalid_references = {
    "tag": "owner/action@v4",
    "branch": "owner/action@main",
    "short-sha": "owner/action@0123456789abcdef",
    "expression": "owner/action@${{ github.sha }}",
    "missing-ref": "owner/action",
    "docker-tag": "docker://alpine:3.23",
    "docker-short": f"docker://alpine@sha256:{digest[:-1]}",
    "docker-algorithm": f"docker://alpine@sha512:{digest}",
    "docker-malformed": f"docker://@sha256:{digest}",
}
for name, reference in invalid_references.items():
    repository = root / f"invalid-{name}"
    workflow(repository, f"      - uses: {reference}\n")

same_repo_action_ref = root / "invalid-dollar-action-ref"
workflow(
    same_repo_action_ref,
    "      - uses: $/.github/actions/first@v1\n",
)
same_repo_workflow_ref = root / "invalid-dollar-workflow-ref"
write(
    same_repo_workflow_ref / ".github/workflows/check.yml",
    "jobs:\n  call:\n    uses: $/.github/workflows/reusable.yml@v1\n",
)
same_repo_composite_ref = root / "invalid-dollar-composite-ref"
workflow(
    same_repo_composite_ref,
    "      - uses: $/.github/actions/first\n",
)
write(
    same_repo_composite_ref / ".github/actions/first/action.yml",
    "runs:\n  using: composite\n  steps:\n"
    "    - uses: $/.github/actions/second@v1\n",
)

composite = root / "invalid-composite-bypass"
workflow(composite, "      - uses: $/.github/actions/first\n")
write(
    composite / ".github/actions/first/action.yml",
    "runs:\n  using: composite\n  steps:\n    - uses: owner/action@v4\n",
)

cycle = root / "invalid-composite-cycle"
workflow(cycle, "      - uses: $/.github/actions/first\n")
write(
    cycle / ".github/actions/first/action.yml",
    "runs:\n  using: composite\n  steps:\n    - uses: $/.github/actions/second\n",
)
write(
    cycle / ".github/actions/second/action.yml",
    "runs:\n  using: composite\n  steps:\n    - uses: $/.github/actions/first\n",
)

parallel_remote = root / "invalid-parallel-remote"
workflow(
    parallel_remote,
    "      - parallel:\n          - uses: owner/action@v4\n",
)
parallel_docker = root / "invalid-parallel-docker"
workflow(
    parallel_docker,
    "      - parallel:\n          - parallel:\n"
    "              - uses: docker://alpine:3.23\n",
)
parallel_cycle = root / "invalid-parallel-cycle"
write(
    parallel_cycle / ".github/workflows/check.yml",
    "jobs:\n  check:\n    steps: &steps\n      - parallel: *steps\n",
)

outside_action = root / "outside-action"
write(
    outside_action / "action.yml",
    f"runs:\n  using: composite\n  steps:\n    - uses: owner/action@{sha}\n",
)
path_escape = root / "invalid-path-escape"
workflow(path_escape, "      - uses: ./../outside-action\n")
same_repo_path_escape = root / "invalid-dollar-path-escape"
workflow(same_repo_path_escape, "      - uses: $/../outside-action\n")

symlink_escape = root / "invalid-symlink-escape"
workflow(symlink_escape, "      - uses: ./.github/actions/escape\n")
(symlink_escape / ".github/actions").mkdir(parents=True)
(symlink_escape / ".github/actions/escape").symlink_to(
    outside_action, target_is_directory=True
)

manifest_escape = root / "invalid-manifest-symlink-escape"
workflow(manifest_escape, "      - uses: $/.github/actions/escape\n")
(manifest_escape / ".github/actions/escape").mkdir(parents=True)
(manifest_escape / ".github/actions/escape/action.yml").symlink_to(
    outside_action / "action.yml"
)

ambiguous = root / "invalid-ambiguous-manifest"
workflow(ambiguous, "      - uses: $/.github/actions/ambiguous\n")
write(
    ambiguous / ".github/actions/ambiguous/action.yml",
    "runs:\n  using: node24\n  main: index.js\n",
)
write(
    ambiguous / ".github/actions/ambiguous/action.yaml",
    "runs:\n  using: node24\n  main: index.js\n",
)

outside_workflow = root / "outside-workflow.yml"
write(outside_workflow, f"jobs:\n  check:\n    uses: owner/project@{sha}\n")
workflow_escape = root / "invalid-workflow-escape"
write(
    workflow_escape / ".github/workflows/check.yml",
    "jobs:\n  check:\n    uses: $/../outside-workflow.yml\n",
)

reusable_bypass = root / "invalid-reusable-workflow-bypass"
write(
    reusable_bypass / ".github/workflows/check.yml",
    "jobs:\n  call:\n    uses: $/.github/workflows/reusable.yml\n",
)
write(
    reusable_bypass / ".github/workflows/reusable.yml",
    "jobs:\n  check:\n    steps:\n      - uses: owner/action@v4\n",
)

missing_manifest = root / "invalid-missing-manifest"
workflow(missing_manifest, "      - uses: $/.github/actions/missing\n")
(missing_manifest / ".github/actions/missing").mkdir(parents=True)

non_scalar = root / "invalid-non-scalar"
workflow(non_scalar, "      - uses: [owner/action]\n")

malformed_action = root / "invalid-malformed-action"
workflow(malformed_action, "      - uses: ./.github/actions/broken\n")
write(malformed_action / ".github/actions/broken/action.yml", "runs: [")
PY

python "$checker" "$work/valid"

expect_rejected() {
  local repository="$1"
  local expected="$2"
  local output
  if output="$(python "$checker" "$repository" 2>&1)"; then
    printf 'action pin checker accepted invalid fixture: %s\n' \
      "$(basename "$repository")" >&2
    exit 1
  fi
  if ! grep -Fq "$expected" <<< "$output" || grep -Fq 'Traceback' <<< "$output"; then
    printf 'action pin checker gave an unclear rejection for %s:\n%s\n' \
      "$(basename "$repository")" "$output" >&2
    exit 1
  fi
}

for invalid in "$work"/invalid-*; do
  case "$(basename "$invalid")" in
    invalid-composite-cycle)
      expected='local composite action cycle'
      ;;
    invalid-dollar-*-ref)
      expected='$/ uses reference must not include an @ref suffix'
      ;;
    invalid-dollar-path-escape | invalid-manifest-symlink-escape | \
      invalid-path-escape | invalid-symlink-escape | invalid-workflow-escape)
      expected='resolves outside the repository'
      ;;
    invalid-docker-* | invalid-parallel-docker)
      expected='Docker uses reference must end'
      ;;
    invalid-parallel-cycle)
      expected='parallel step sequence cycle'
      ;;
    invalid-malformed-action)
      expected='YAML cannot be checked safely'
      ;;
    invalid-ambiguous-manifest | invalid-missing-manifest)
      expected='must contain exactly one action.yml or action.yaml'
      ;;
    invalid-non-scalar)
      expected='uses reference is not a scalar'
      ;;
    *)
      expected='remote uses reference must end'
      ;;
  esac
  expect_rejected "$invalid" "$expected"
done

printf 'GitHub Actions commit pin fixtures passed\n'
