"""Validate release workflow inputs and the private candidate run identity."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

COMMIT = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/"
    r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
)
VERSION = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")
MAX_GITHUB_ID = "9223372036854775807"
MAX_VERSION_COMPONENT = "65535"


class ValidationError(RuntimeError):
    pass


def fail(message: str) -> None:
    raise ValidationError(message)


def canonical_positive_id(value: str) -> bool:
    return (
        value.isascii()
        and value.isdigit()
        and value[0] != "0"
        and (
            len(value) < len(MAX_GITHUB_ID)
            or (len(value) == len(MAX_GITHUB_ID) and value <= MAX_GITHUB_ID)
        )
    )


def valid_version(value: str) -> bool:
    if VERSION.fullmatch(value) is None:
        return False
    parts = value.split(".")
    return any(part != "0" for part in parts) and all(
        len(part) < len(MAX_VERSION_COMPONENT)
        or (len(part) == len(MAX_VERSION_COMPONENT) and part <= MAX_VERSION_COMPONENT)
        for part in parts
    )


def append_outputs(path: Path, values: dict[str, str]) -> None:
    with path.open("a", encoding="utf-8") as output:
        for key, value in values.items():
            if "\r" in value or "\n" in value:
                fail(f"workflow output {key} contains a newline")
            output.write(f"{key}={value}\n")


def validate_common(args: argparse.Namespace) -> None:
    if not canonical_positive_id(args.source_run_id):
        fail("source run ID must be a bounded canonical positive decimal integer")
    if not COMMIT.fullmatch(args.source_sha):
        fail("source SHA must be 40 lowercase hexadecimal characters")
    if not valid_version(args.version):
        fail("version must be a nonzero bounded three-part release version")
    if args.destination and not REPOSITORY.fullmatch(args.destination):
        fail("destination repository input must be one literal owner/name")
    if args.mode == "publish":
        if not canonical_positive_id(args.release_id):
            fail("publish requires a bounded canonical positive draft release ID")
        if not COMMIT.fullmatch(args.candidate_commit):
            fail("publish requires the exact owner-accepted candidate commit")
    elif args.release_id or args.candidate_commit:
        fail("only publish may receive a draft release identity")


def validate_destination(args: argparse.Namespace) -> None:
    supplied = args.input_repository
    configured = args.configured_repository
    for description, value in (
        ("input", supplied),
        ("repository variable", configured),
    ):
        if value and not REPOSITORY.fullmatch(value):
            fail(f"destination repository {description} must be one literal owner/name")
    if not configured:
        fail("destination repository variable is not configured")
    if supplied and supplied != configured:
        fail("destination repository input and repository variable disagree")
    destination = configured
    owner, repository = destination.split("/", 1)
    append_outputs(
        args.github_output,
        {"destination": destination, "owner": owner, "repository": repository},
    )


def validate_source_run(args: argparse.Namespace) -> None:
    if not canonical_positive_id(args.source_run_id):
        fail("source run ID must be a bounded canonical positive decimal integer")
    if not COMMIT.fullmatch(args.source_sha):
        fail("source SHA must be 40 lowercase hexadecimal characters")
    if not REPOSITORY.fullmatch(args.source_repository):
        fail("source repository must be one literal owner/name")
    try:
        run = json.loads(args.run_json.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"source run response cannot be parsed safely: {error}")
    if not isinstance(run, dict):
        fail("source run response is not an object")
    expected: dict[str, object] = {
        "id": int(args.source_run_id),
        "head_sha": args.source_sha,
        "status": "completed",
        "conclusion": "success",
        "event": "push",
        "head_branch": "master",
    }
    for key, value in expected.items():
        if run.get(key) != value:
            fail(
                f"source run {key} does not match the requested successful master push"
            )
    repository = run.get("repository")
    if (
        not isinstance(repository, dict)
        or repository.get("full_name") != args.source_repository
    ):
        fail("source run repository does not match")
    path = run.get("path")
    if path != ".github/workflows/arch-package.yml":
        fail("source run did not execute the protected Arch package workflow on master")
    if (
        not isinstance(run.get("run_attempt"), int)
        or isinstance(run["run_attempt"], bool)
        or not 1 <= run["run_attempt"] <= 65535
    ):
        fail("source run attempt is invalid")
    append_outputs(
        args.github_output,
        {
            "run_attempt": str(run["run_attempt"]),
            "workflow_ref": f"{args.source_repository}/{path}@refs/heads/master",
        },
    )


def load_object(path: Path, description: str) -> dict[str, object]:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"{description} cannot be parsed safely: {error}")
    if not isinstance(value, dict):
        fail(f"{description} is not an object")
    return value


def validate_trusted_run(args: argparse.Namespace) -> None:
    if not REPOSITORY.fullmatch(args.repository):
        fail("workflow repository must be one literal owner/name")
    for description, sha in (
        ("workflow", args.workflow_sha),
        ("dispatch", args.dispatch_sha),
        ("checkout", args.checkout_sha),
    ):
        if not COMMIT.fullmatch(sha):
            fail(f"{description} SHA must be 40 lowercase hexadecimal characters")
    expected_ref = f"{args.repository}/.github/workflows/release.yml@refs/heads/master"
    if args.workflow_ref != expected_ref:
        fail("release workflow did not run from protected master")
    if len({args.workflow_sha, args.dispatch_sha, args.checkout_sha}) != 1:
        fail("release workflow, dispatch, and trusted checkout SHAs differ")

    branch = load_object(args.branch_json, "master branch response")
    commit = branch.get("commit")
    if (
        branch.get("name") != "master"
        or branch.get("protected") is not True
        or not isinstance(commit, dict)
        or commit.get("sha") != args.workflow_sha
    ):
        fail("release workflow SHA is not the current protected master")
    reference = load_object(args.ref_json, "master ref response")
    target = reference.get("object")
    if (
        reference.get("ref") != "refs/heads/master"
        or not isinstance(target, dict)
        or target.get("type") != "commit"
        or target.get("sha") != args.workflow_sha
    ):
        fail("release workflow SHA does not match the current master ref")
    append_outputs(args.github_output, {"trusted_sha": args.workflow_sha})


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    subparsers = result.add_subparsers(dest="command", required=True)

    common = subparsers.add_parser("inputs")
    common.add_argument(
        "--mode", choices=("dry-run", "stage", "publish"), required=True
    )
    common.add_argument("--source-run-id", required=True)
    common.add_argument("--source-sha", required=True)
    common.add_argument("--version", required=True)
    common.add_argument("--destination", default="")
    common.add_argument("--release-id", default="")
    common.add_argument("--candidate-commit", default="")

    destination = subparsers.add_parser("destination")
    destination.add_argument("--input-repository", default="")
    destination.add_argument("--configured-repository", default="")
    destination.add_argument("--github-output", type=Path, required=True)

    source = subparsers.add_parser("source-run")
    source.add_argument("--run-json", type=Path, required=True)
    source.add_argument("--source-repository", required=True)
    source.add_argument("--source-run-id", required=True)
    source.add_argument("--source-sha", required=True)
    source.add_argument("--github-output", type=Path, required=True)

    trusted = subparsers.add_parser("trusted-run")
    trusted.add_argument("--repository", required=True)
    trusted.add_argument("--workflow-ref", required=True)
    trusted.add_argument("--workflow-sha", required=True)
    trusted.add_argument("--dispatch-sha", required=True)
    trusted.add_argument("--checkout-sha", required=True)
    trusted.add_argument("--branch-json", type=Path, required=True)
    trusted.add_argument("--ref-json", type=Path, required=True)
    trusted.add_argument("--github-output", type=Path, required=True)
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "inputs":
            validate_common(args)
        elif args.command == "destination":
            validate_destination(args)
        elif args.command == "trusted-run":
            validate_trusted_run(args)
        else:
            validate_source_run(args)
    except (OSError, ValidationError) as error:
        print(f"release workflow validation failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
