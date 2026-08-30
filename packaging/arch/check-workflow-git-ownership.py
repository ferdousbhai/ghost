#!/usr/bin/env python3

"""Bind the Arch package job and its post-transfer UID boundary exactly."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode
from yaml.tokens import AliasToken, AnchorToken


PACKAGE_SHA256 = "78a359ffedd0fda8b6918c88ec6b846ee30d460b80e928f05a8963d0b795711d"
EXPECTED_STEP_NAMES = [
    "Update package database and install checkout dependency",
    None,
    "Verify container-local source resolution",
    "Install declared package dependencies",
    "Lint and type-check desktop helper",
    "Create unprivileged package builder",
    "Verify CI privilege boundaries",
    "Prepare builder-owned release paths",
    "Verify package check dependency coverage",
    "Build and smoke-test the package",
    "Build and verify stable release sources offline",
    "Seal release artifacts for upload",
    "Upload package artifact",
    "Upload stable release-source artifacts",
    "Remove trusted release outer",
]
EXPECTED_USES = {
    1: "actions/checkout@v4",
    12: "actions/upload-artifact@v4",
    13: "actions/upload-artifact@v4",
}
EXPECTED_WORKING_DIRECTORIES = {4: "packages/desktop-helper"}
JOB_KEYS = {"runs-on", "container", "steps"}
STEP_KEYS = {
    "name",
    "shell",
    "run",
    "uses",
    "with",
    "env",
    "if",
    "continue-on-error",
    "working-directory",
}
TRANSFER_STEP = "Prepare builder-owned release paths"


class UniqueKeyLoader(yaml.SafeLoader):
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


def mapping(node: Node | None, context: str) -> dict[str, Node]:
    if not isinstance(node, MappingNode):
        raise ValueError(f"{context} is not a mapping")
    result: dict[str, Node] = {}
    for key_node, value_node in node.value:
        if not isinstance(key_node, ScalarNode):
            raise ValueError(f"{context} has a non-scalar key")
        if key_node.value in result:
            raise ValueError(f"{context} has duplicate key {key_node.value!r}")
        result[key_node.value] = value_node
    return result


def scalar(node: Node | None, context: str) -> str:
    if not isinstance(node, ScalarNode):
        raise ValueError(f"{context} is not a scalar")
    return node.value


def package_node(document: Node) -> MappingNode:
    root = mapping(document, "workflow")
    jobs = mapping(root.get("jobs"), "jobs")
    package = jobs.get("package")
    if not isinstance(package, MappingNode):
        raise ValueError("workflow package job is missing or not a mapping")
    return package


def one_exec_command(script: str) -> bool:
    lines = [line for line in script.rstrip("\n").splitlines() if line.strip()]
    if not lines or not lines[0].lstrip().startswith("exec "):
        return False
    return all(line.rstrip().endswith("\\") for line in lines[:-1]) and not lines[
        -1
    ].rstrip().endswith("\\")


def structural_errors(text: str) -> list[str]:
    errors: list[str] = []
    try:
        if any(isinstance(token, (AliasToken, AnchorToken)) for token in yaml.scan(text)):
            errors.append("workflow must not contain YAML anchors or aliases")
        loaded = yaml.load(text, Loader=UniqueKeyLoader)
        if not isinstance(loaded, dict):
            raise ValueError("workflow document is not a mapping")
        loaded_jobs = loaded.get("jobs")
        if not isinstance(loaded_jobs, dict) or not isinstance(
            loaded_jobs.get("package"), dict
        ):
            raise ValueError("loaded workflow has no package job mapping")
        document = yaml.compose(text, Loader=UniqueKeyLoader)
        if document is None:
            raise ValueError("workflow document is empty")
        job = package_node(document)
        source = text[job.start_mark.index : job.end_mark.index]
    except (ValueError, yaml.YAMLError) as error:
        return [f"workflow YAML cannot be validated safely: {error}"]

    job_map = mapping(job, "package job")
    if set(job_map) != JOB_KEYS:
        errors.append("package job keys changed (env/defaults/extra keys are forbidden)")
    if scalar(job_map.get("runs-on"), "package runs-on") != "ubuntu-latest":
        errors.append("package runner changed")
    if scalar(job_map.get("container"), "package container") != "archlinux:base-devel":
        errors.append("package container changed")
    steps_node = job_map.get("steps")
    if not isinstance(steps_node, SequenceNode):
        return errors + ["package steps is not a sequence"]
    if len(steps_node.value) != len(EXPECTED_STEP_NAMES):
        return errors + ["package step count changed"]

    transfer_seen = False
    for index, step_node in enumerate(steps_node.value):
        step = mapping(step_node, f"package step {index}")
        if not set(step).issubset(STEP_KEYS):
            errors.append(f"package step {index} has an unsupported key")
        name_node = step.get("name")
        name = (
            scalar(name_node, f"package step {index} name")
            if name_node is not None
            else None
        )
        if name != EXPECTED_STEP_NAMES[index]:
            errors.append(f"package step {index} name/order changed")
        if index in EXPECTED_USES:
            if set(step) - {"name", "uses", "with"}:
                errors.append(f"uses step {index} has shell-only or control keys")
            if scalar(step.get("uses"), f"uses step {index}") != EXPECTED_USES[index]:
                errors.append(f"uses ref changed at package step {index}")
            if not isinstance(step.get("with"), MappingNode):
                errors.append(f"uses step {index} has invalid with mapping")
        if name == TRANSFER_STEP:
            transfer_seen = True
        run_node = step.get("run")
        if transfer_seen and run_node is not None and name != TRANSFER_STEP:
            if not isinstance(run_node, ScalarNode) or run_node.style != "|":
                errors.append(f"post-transfer run step {index} is not literal style")
            elif not one_exec_command(run_node.value):
                errors.append(f"post-transfer run step {index} is not one exec command")
        expected_working_directory = EXPECTED_WORKING_DIRECTORIES.get(index)
        working_directory = step.get("working-directory")
        if expected_working_directory is None:
            if working_directory is not None:
                errors.append(f"package step {index} sets forbidden working-directory")
        elif not isinstance(working_directory, ScalarNode) or (
            working_directory.value != expected_working_directory
        ):
            errors.append(f"package step {index} working-directory changed")
        if "continue-on-error" in step:
            errors.append(f"package step {index} sets forbidden continue-on-error")

    digest = hashlib.sha256(source.encode("utf-8")).hexdigest()
    if digest != PACKAGE_SHA256:
        errors.append("raw package job command/style/schema digest changed")
    return errors


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-workflow-git-ownership.py <workflow>", file=sys.stderr)
        return 2
    workflow = Path(sys.argv[1])
    errors = structural_errors(workflow.read_text(encoding="utf-8"))
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("Arch package workflow AST and UID boundaries passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
