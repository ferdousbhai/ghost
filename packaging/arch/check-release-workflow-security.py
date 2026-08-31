#!/usr/bin/env python3

"""Bind the manual release workflow's credential and publication boundaries."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

import yaml
from yaml.nodes import MappingNode
from yaml.tokens import AliasToken, AnchorToken

WORKFLOW_SHA256 = "2aeee44dedbdbe009d153be1341cebbc092864230b7830c4f75093459c8d9d45"
CANDIDATE_STEPS = [
    None,
    None,
    "Verify trusted protected-master orchestration",
    "Validate manual release inputs",
    "Resolve repository-level destination",
    "Verify successful source run identity",
    "Exercise release orchestration fixtures",
    None,
    None,
    "Verify downloaded public candidate",
    "Record dry-run result",
]
PUBLICATION_STEPS = [
    None,
    None,
    None,
    "Resolve repository-level destination",
    None,
    "Redownload and reverify candidate before minting",
    "Reconfirm trusted protected master after environment admission",
    "Mint least-privilege publication token",
    "Preflight public repository and immutable releases",
    "Create or resume draft without overwriting assets",
    "Publish exact staged draft and verify anonymous downloads",
    "Record staged draft identity",
]
PINNED = {
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
    "actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1",
}


class UniqueKeyLoader(yaml.BaseLoader):
    pass


def construct_unique_mapping(
    loader: UniqueKeyLoader, node: MappingNode, deep: bool = False
) -> dict[Any, Any]:
    mapping: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate key: {key!r}",
                key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    construct_unique_mapping,
)


def mapping(value: object, description: str) -> dict[str, Any]:
    if not isinstance(value, dict) or any(not isinstance(key, str) for key in value):
        raise ValueError(f"{description} is not a string-keyed mapping")
    return value


def steps(
    job: dict[str, Any], expected: list[str | None], description: str
) -> list[dict[str, Any]]:
    value = job.get("steps")
    if not isinstance(value, list) or any(not isinstance(step, dict) for step in value):
        raise ValueError(f"{description} steps are not a mapping sequence")
    if [step.get("name") for step in value] != expected:
        raise ValueError(f"{description} step identity/order changed")
    return value


def structural_errors(text: str) -> list[str]:
    errors: list[str] = []
    try:
        if any(
            isinstance(token, (AliasToken, AnchorToken)) for token in yaml.scan(text)
        ):
            errors.append("release workflow must not contain YAML anchors or aliases")
        workflow = mapping(yaml.load(text, Loader=UniqueKeyLoader), "workflow")
        trigger = mapping(workflow.get("on"), "workflow trigger")
        dispatch = mapping(trigger.get("workflow_dispatch"), "workflow_dispatch")
        inputs = mapping(dispatch.get("inputs"), "workflow_dispatch inputs")
        permissions = mapping(workflow.get("permissions"), "workflow permissions")
        concurrency = mapping(workflow.get("concurrency"), "workflow concurrency")
        jobs = mapping(workflow.get("jobs"), "workflow jobs")
        candidate = mapping(jobs.get("candidate"), "candidate job")
        publication = mapping(jobs.get("publication"), "publication job")
        candidate_steps = steps(candidate, CANDIDATE_STEPS, "candidate")
        publication_steps = steps(publication, PUBLICATION_STEPS, "publication")
    except (ValueError, yaml.YAMLError) as error:
        return [f"release workflow YAML cannot be validated safely: {error}"]

    if set(workflow) != {"name", "on", "permissions", "concurrency", "jobs"}:
        errors.append("release workflow top-level keys changed")
    if set(trigger) != {"workflow_dispatch"}:
        errors.append("release workflow gained a non-manual trigger")
    if set(inputs) != {
        "mode",
        "source_run_id",
        "source_sha",
        "version",
        "destination_repository",
        "draft_release_id",
        "candidate_commit",
    }:
        errors.append("manual release input contract changed")
    if mapping(inputs.get("mode"), "mode input").get("default") != "dry-run":
        errors.append("manual release mode is not dry-run by default")
    for name in ("destination_repository", "draft_release_id", "candidate_commit"):
        if mapping(inputs.get(name), f"{name} input").get("default") != "":
            errors.append(f"{name} gained a nonempty default")
    if permissions != {"actions": "read", "contents": "read"}:
        errors.append("built-in workflow token permissions changed")
    if concurrency != {
        "group": "ghost-public-release",
        "cancel-in-progress": "false",
    }:
        errors.append("global non-cancelling release serialization changed")
    if set(jobs) != {"candidate", "publication"}:
        errors.append("release workflow job set changed")
    if "environment" in candidate or "permissions" in candidate:
        errors.append("candidate validation job gained credentials or permissions")
    if mapping(candidate.get("outputs"), "candidate outputs") != {
        "destination": "${{ steps.expected-destination.outputs.destination }}",
        "run_attempt": "${{ steps.source-run.outputs.run_attempt }}",
        "trusted_sha": "${{ steps.trusted.outputs.trusted_sha }}",
        "workflow_ref": "${{ steps.source-run.outputs.workflow_ref }}",
    }:
        errors.append("validated candidate identity outputs changed")
    expected_candidate_if = (
        "github.ref == 'refs/heads/master' && "
        "github.workflow_ref == format('{0}/.github/workflows/release.yml@refs/heads/master', "
        "github.repository) && github.workflow_sha == github.sha"
    )
    if candidate.get("if") != expected_candidate_if:
        errors.append("candidate job lost its protected-master workflow guard")
    if publication.get("environment") != "public-release":
        errors.append("publication job left its protected environment")
    if publication.get("needs") != "candidate":
        errors.append("publication no longer waits for candidate validation")
    expected_publication_if = (
        "needs.candidate.result == 'success' && "
        "(inputs.mode == 'stage' || inputs.mode == 'publish')"
    )
    if publication.get("if") != expected_publication_if:
        errors.append("publication job condition changed")
    if "permissions" in publication:
        errors.append("publication job must not elevate the built-in workflow token")

    uses = {
        step.get("uses")
        for step in [*candidate_steps, *publication_steps]
        if "uses" in step
    }
    if uses != PINNED:
        errors.append("release workflow action identities changed")
    checkout = next(
        reference for reference in PINNED if "actions/checkout" in reference
    )
    setup_python = next(
        reference for reference in PINNED if "actions/setup-python" in reference
    )
    expected_checkouts = [
        (
            candidate_steps[0],
            {
                "ref": "${{ github.workflow_sha }}",
                "fetch-depth": "1",
                "path": "orchestration",
                "persist-credentials": "false",
            },
        ),
        (
            candidate_steps[7],
            {
                "ref": "${{ inputs.source_sha }}",
                "fetch-depth": "1",
                "path": "source",
                "persist-credentials": "false",
            },
        ),
        (
            publication_steps[0],
            {
                "ref": "${{ needs.candidate.outputs.trusted_sha }}",
                "fetch-depth": "1",
                "path": "orchestration",
                "persist-credentials": "false",
            },
        ),
        (
            publication_steps[2],
            {
                "ref": "${{ inputs.source_sha }}",
                "fetch-depth": "1",
                "path": "source",
                "persist-credentials": "false",
            },
        ),
    ]
    for checkout_step, expected_with in expected_checkouts:
        if (
            checkout_step.get("uses") != checkout
            or mapping(checkout_step.get("with"), "trusted/source checkout inputs")
            != expected_with
        ):
            errors.append("trusted orchestration or inert source checkout changed")
    for setup_step in (candidate_steps[1], publication_steps[1]):
        if setup_step.get("uses") != setup_python or mapping(
            setup_step.get("with"), "Python setup inputs"
        ) != {"python-version": "3.14"}:
            errors.append("release workflow must use uncached Python 3.14")

    expected_downloads = [
        (
            candidate_steps[8],
            {
                "name": (
                    "ghost-public-candidate-${{ inputs.source_sha }}-"
                    "${{ steps.source-run.outputs.run_attempt }}"
                ),
                "path": "candidate",
                "repository": "${{ github.repository }}",
                "run-id": "${{ inputs.source_run_id }}",
                "github-token": "${{ github.token }}",
            },
        ),
        (
            publication_steps[4],
            {
                "name": (
                    "ghost-public-candidate-${{ inputs.source_sha }}-"
                    "${{ needs.candidate.outputs.run_attempt }}"
                ),
                "path": "candidate",
                "repository": "${{ github.repository }}",
                "run-id": "${{ inputs.source_run_id }}",
                "github-token": "${{ github.token }}",
            },
        ),
    ]
    download = next(
        reference for reference in PINNED if "actions/download-artifact" in reference
    )
    for download_step, expected_with in expected_downloads:
        if (
            download_step.get("uses") != download
            or mapping(download_step.get("with"), "candidate download inputs")
            != expected_with
        ):
            errors.append("candidate download lost exact run-attempt identity")

    input_validation = str(candidate_steps[3].get("run", ""))
    if '--candidate-commit "$CANDIDATE_COMMIT"' not in input_validation:
        errors.append("publish approval commit is not validated before admission")
    expected_destination_envs = (
        (
            candidate_steps[4],
            {
                "INPUT_REPOSITORY": "${{ inputs.destination_repository }}",
                "CONFIGURED_REPOSITORY": "${{ vars.GHOST_RELEASE_REPOSITORY }}",
            },
        ),
        (
            publication_steps[3],
            {
                "INPUT_REPOSITORY": "${{ inputs.destination_repository }}",
                "CONFIGURED_REPOSITORY": ("${{ needs.candidate.outputs.destination }}"),
            },
        ),
    )
    for destination_step, expected_env in expected_destination_envs:
        if mapping(
            destination_step.get("env"), "destination resolution environment"
        ) != (expected_env):
            errors.append(
                "destination is no longer bound to the repository-level variable"
            )

    reconfirm = publication_steps[6]
    expected_reconfirm_env = {
        "GH_TOKEN": "${{ github.token }}",
        "SOURCE_REPOSITORY": "${{ github.repository }}",
        "TRUSTED_SHA": "${{ needs.candidate.outputs.trusted_sha }}",
        "WORKFLOW_REF": "${{ github.workflow_ref }}",
    }
    if mapping(reconfirm.get("env"), "publication trust recheck environment") != (
        expected_reconfirm_env
    ):
        errors.append("publication protected-master recheck identity changed")
    reconfirm_run = str(reconfirm.get("run", ""))
    required_reconfirm_fragments = {
        "git -C orchestration rev-parse 'HEAD^{commit}'",
        'gh api "repos/$SOURCE_REPOSITORY/branches/master"',
        'gh api "repos/$SOURCE_REPOSITORY/git/ref/heads/master"',
        "validate-release-workflow.py trusted-run",
        '--workflow-ref "$WORKFLOW_REF"',
        '--workflow-sha "$TRUSTED_SHA"',
        '--dispatch-sha "$TRUSTED_SHA"',
        '--checkout-sha "$CHECKOUT_SHA"',
        "--branch-json publication-branch.json",
        "--ref-json publication-ref.json",
    }
    if any(fragment not in reconfirm_run for fragment in required_reconfirm_fragments):
        errors.append("publication protected-master recheck was weakened")

    app = publication_steps[7]
    if app.get("uses") != next(
        reference for reference in PINNED if "create-github-app-token" in reference
    ):
        errors.append("publication token is not minted at the approved boundary")
    expected_app_inputs = {
        "client-id": "${{ vars.GHOST_RELEASE_APP_CLIENT_ID }}",
        "private-key": "${{ secrets.GHOST_RELEASE_APP_PRIVATE_KEY }}",
        "owner": "${{ steps.destination.outputs.owner }}",
        "repositories": "${{ steps.destination.outputs.repository }}",
        "permission-administration": "read",
        "permission-contents": "write",
    }
    if mapping(app.get("with"), "GitHub App token inputs") != expected_app_inputs:
        errors.append("GitHub App token scope or protected identity changed")
    serialized_candidate = yaml.safe_dump(candidate, sort_keys=True)
    if (
        "secrets." in serialized_candidate
        or "create-github-app-token" in serialized_candidate
    ):
        errors.append("candidate validation job can access publication credentials")
    serialized = yaml.safe_dump(workflow, sort_keys=True)
    if "--clobber" in serialized:
        errors.append("release workflow enables asset overwrite")
    if serialized.count("secrets.GHOST_RELEASE_APP_PRIVATE_KEY") != 1:
        errors.append("App private key must be passed only to the pinned token action")
    local_runs = "\n".join(
        str(step.get("run", "")) for step in [*candidate_steps, *publication_steps]
    )
    if "python .github/" in local_runs or "python source/" in local_runs:
        errors.append(
            "release helpers can execute outside trusted orchestration checkout"
        )
    if "release-draft.py preflight" not in str(publication_steps[8].get("run", "")):
        errors.append("immutable release preflight is missing before publication")
    if publication_steps[9].get("if") != "inputs.mode == 'stage'":
        errors.append("draft staging is not isolated to stage mode")
    if publication_steps[10].get("if") != "inputs.mode == 'publish'":
        errors.append("publication is not isolated to publish mode")
    publish_run = str(publication_steps[10].get("run", ""))
    if (
        '--release-id "$DRAFT_RELEASE_ID"' not in publish_run
        or '--accepted-candidate-commit "$ACCEPTED_CANDIDATE_COMMIT"' not in publish_run
    ):
        errors.append("publication lost exact draft and accepted-commit binding")

    if hashlib.sha256(text.encode("utf-8")).hexdigest() != WORKFLOW_SHA256:
        errors.append("raw release workflow command/style/schema digest changed")
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-release-workflow-security.py <workflow>", file=sys.stderr)
        return 2
    path = Path(sys.argv[1])
    try:
        errors = structural_errors(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError) as error:
        print(f"release workflow cannot be read safely: {error}", file=sys.stderr)
        return 2
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Manual release credential and publication boundaries passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
