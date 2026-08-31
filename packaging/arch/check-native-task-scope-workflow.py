#!/usr/bin/env python3

"""Bind the dedicated real-systemd task-scope CI boundary exactly."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path
from typing import Any

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode
from yaml.tokens import AliasToken, AnchorToken


JOB_SHA256 = "f212f10e83b3d4c35454c94fd67ade08557b5dbe8f1eb3481bf6ef899dd5dd7a"
CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1"
SETUP_BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6"
STEP_NAMES = [
    None,
    None,
    "Install and build the tested tree",
    "Start a dedicated ephemeral user manager",
    "Exercise real receipt-bound scopes",
    "Remove the dedicated user manager",
]


class UniqueKeyLoader(yaml.SafeLoader):
    pass


def construct_unique_mapping(
    loader: UniqueKeyLoader, node: MappingNode, deep: bool = False
) -> dict[Any, Any]:
    result: dict[Any, Any] = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in result:
            raise yaml.constructor.ConstructorError(
                "while constructing a mapping",
                node.start_mark,
                f"duplicate key: {key!r}",
                key_node.start_mark,
            )
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueKeyLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG,
    construct_unique_mapping,
)


def mapping(node: Node | None, context: str) -> dict[str, Node]:
    if not isinstance(node, MappingNode):
        raise TypeError(f"{context} is not a mapping")
    result: dict[str, Node] = {}
    for key_node, value_node in node.value:
        if not isinstance(key_node, ScalarNode):
            raise TypeError(f"{context} has a non-scalar key")
        if key_node.value in result:
            raise ValueError(f"{context} has duplicate key {key_node.value!r}")
        result[key_node.value] = value_node
    return result


def scalar(node: Node | None, context: str) -> str:
    if not isinstance(node, ScalarNode):
        raise TypeError(f"{context} is not a scalar")
    return node.value


def sequence(node: Node | None, context: str) -> list[Node]:
    if not isinstance(node, SequenceNode):
        raise TypeError(f"{context} is not a sequence")
    return node.value


def errors(text: str) -> list[str]:
    failures: list[str] = []
    try:
        if any(isinstance(token, (AliasToken, AnchorToken)) for token in yaml.scan(text)):
            failures.append("workflow must not contain YAML anchors or aliases")
        yaml.load(text, Loader=UniqueKeyLoader)
        document = yaml.compose(text, Loader=UniqueKeyLoader)
        if document is None:
            raise ValueError("workflow is empty")
        root = mapping(document, "workflow")
        trigger = mapping(root.get("on"), "trigger")
        push = mapping(trigger.get("push"), "push trigger")
        permissions = mapping(root.get("permissions"), "permissions")
        jobs = mapping(root.get("jobs"), "jobs")
        job_node = jobs.get("systemd-scope")
        job = mapping(job_node, "systemd-scope job")
        steps = sequence(job.get("steps"), "systemd-scope steps")
    except (TypeError, ValueError, yaml.YAMLError) as error:
        return [*failures, f"workflow cannot be validated safely: {error}"]

    if set(root) != {"name", "on", "permissions", "jobs"}:
        failures.append("workflow top-level keys changed")
    if set(trigger) != {"pull_request", "push"}:
        failures.append("workflow triggers changed")
    pull_request = trigger.get("pull_request")
    if not isinstance(pull_request, ScalarNode) or pull_request.value != "":
        failures.append("pull_request trigger changed")
    if set(push) != {"branches"} or not isinstance(push.get("branches"), SequenceNode):
        failures.append("push trigger changed")
    elif [scalar(item, "push branch") for item in push["branches"].value] != ["master"]:
        failures.append("push branch changed")
    if set(permissions) != {"contents"} or scalar(
        permissions.get("contents"), "contents permission"
    ) != "read":
        failures.append("workflow permissions changed")
    if set(jobs) != {"systemd-scope"}:
        failures.append("workflow must contain only the systemd-scope job")
    if set(job) != {"runs-on", "timeout-minutes", "steps"}:
        failures.append("systemd-scope job keys changed")
    if scalar(job.get("runs-on"), "runner") != "ubuntu-24.04":
        failures.append("systemd PID1 runner changed")
    if scalar(job.get("timeout-minutes"), "job timeout") != "20":
        failures.append("systemd integration timeout changed")
    if len(steps) != len(STEP_NAMES):
        failures.append("workflow step count changed")
    else:
        for index, node in enumerate(steps):
            step = mapping(node, f"step {index}")
            name = scalar(step.get("name"), f"step {index} name") if "name" in step else None
            if name != STEP_NAMES[index]:
                failures.append(f"step {index} name or order changed")
        first = mapping(steps[0], "checkout step")
        second = mapping(steps[1], "setup-bun step")
        if set(first) != {"uses"} or scalar(first.get("uses"), "checkout ref") != CHECKOUT:
            failures.append("checkout action changed")
        if set(second) != {"uses", "with"} or scalar(second.get("uses"), "setup-bun ref") != SETUP_BUN:
            failures.append("setup-bun action changed")
        else:
            inputs = mapping(second.get("with"), "setup-bun inputs")
            if set(inputs) != {"bun-version"} or scalar(
                inputs.get("bun-version"), "bun version"
            ) != "1.3.14":
                failures.append("Bun version changed")

    if isinstance(job_node, MappingNode):
        source = text[job_node.start_mark.index : job_node.end_mark.index]
        if hashlib.sha256(source.encode("utf-8")).hexdigest() != JOB_SHA256:
            failures.append("systemd-scope job command/schema digest changed")
    return failures


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: check-native-task-scope-workflow.py <workflow>", file=sys.stderr)
        return 2
    failures = errors(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print("Native task systemd integration workflow boundary passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
