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


JOB_SHA256 = "708ef9e0a62cb7f73d66463f2127e5fe66676ea5c9d455e2e925d5fac63eb52a"
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


def require_fragments(
    source: str, fragments: list[str], context: str, failures: list[str]
) -> None:
    for fragment in fragments:
        if source.count(fragment) != 1:
            failures.append(f"{context} must contain exactly one {fragment!r}")


def require_order(
    source: str, fragments: list[str], context: str, failures: list[str]
) -> None:
    positions = [source.find(fragment) for fragment in fragments]
    if -1 in positions or positions != sorted(positions):
        failures.append(f"{context} command order changed")


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
        if set(first) != {"uses", "with"} or scalar(
            first.get("uses"), "checkout ref"
        ) != CHECKOUT:
            failures.append("checkout action changed")
        else:
            checkout_inputs = mapping(first.get("with"), "checkout inputs")
            if set(checkout_inputs) != {"persist-credentials"} or scalar(
                checkout_inputs.get("persist-credentials"),
                "checkout persist-credentials",
            ) != "false":
                failures.append("checkout must disable credential persistence")
        if set(second) != {"uses", "with"} or scalar(second.get("uses"), "setup-bun ref") != SETUP_BUN:
            failures.append("setup-bun action changed")
        else:
            inputs = mapping(second.get("with"), "setup-bun inputs")
            if set(inputs) != {"bun-version"} or scalar(
                inputs.get("bun-version"), "bun version"
            ) != "1.3.14":
                failures.append("Bun version changed")

        manager = scalar(mapping(steps[3], "manager step").get("run"), "manager run")
        exercise = scalar(mapping(steps[4], "exercise step").get("run"), "exercise run")
        cleanup = scalar(mapping(steps[5], "cleanup step").get("run"), "cleanup run")
        require_fragments(
            manager,
            [
                'test_uid=23456',
                'runtime_unit="user-runtime-dir@$test_uid.service"',
                'manager_unit="user@$test_uid.service"',
                'override_file="$override_dir/ghost-ci-environment.conf"',
                '[[ "$test_uid" != "$(id -u)" && "$test_uid" -gt 0 ]]',
                '[[ "$override_file" == "/run/systemd/system/user@23456.service.d/ghost-ci-environment.conf" ]]',
                'sudo install -d -m755 -- "$override_dir"',
                "'PAMName='",
                'Environment=HOME=/home/$test_user',
                'Environment=USER=$test_user',
                'Environment=LOGNAME=$test_user',
                'Environment=XDG_RUNTIME_DIR=/run/user/$test_uid',
                'Environment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$test_uid/bus',
                'sudo chmod 644 "$override_file"',
                'sudo systemctl daemon-reload',
                'sudo systemctl start "$runtime_unit" "$manager_unit"',
                'sudo systemctl is-active --quiet "$runtime_unit"',
                'sudo systemctl is-active --quiet "$manager_unit"',
                'sudo loginctl enable-linger "$test_user"',
                '[[ "$(stat -c %u "/run/user/$test_uid/bus")" == "$test_uid" ]]',
                'sudo systemctl --no-pager --full status "$runtime_unit" "$manager_unit"',
                'sudo journalctl --no-pager --lines=80',
                '--unit "$runtime_unit"',
                '--unit "$manager_unit"',
            ],
            "manager bootstrap",
            failures,
        )
        require_order(
            manager,
            [
                'sudo install -d -m755 -- "$override_dir"',
                'sudo chmod 644 "$override_file"',
                'sudo systemctl daemon-reload',
                'sudo systemctl start "$runtime_unit" "$manager_unit"',
                'sudo systemctl is-active --quiet "$runtime_unit"',
                'sudo systemctl is-active --quiet "$manager_unit"',
                'sudo loginctl enable-linger "$test_user"',
                '[[ -S "/run/user/$test_uid/bus" ]]',
            ],
            "manager bootstrap",
            failures,
        )
        require_fragments(
            exercise,
            [
                '[[ "$TEST_USER" == ghost-scope-ci && "$TEST_UID" == 23456 ]]',
                'XDG_RUNTIME_DIR="/run/user/$TEST_UID"',
                'DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$TEST_UID/bus"',
                'GITHUB_ACTIONS=true',
                'GHOST_NATIVE_TASK_SCOPE_INTEGRATION=1',
                'GHOST_NATIVE_TASK_SCOPE_INTEGRATION_UID="$TEST_UID"',
                'GHOST_NATIVE_TASK_SCOPE_OWNER_UID="$OWNER_UID"',
            ],
            "integration invocation",
            failures,
        )
        require_fragments(
            cleanup,
            [
                '[[ "$TEST_USER" == ghost-scope-ci && "$TEST_UID" == 23456 ]]',
                '[[ "$override_file" == "/run/systemd/system/user@23456.service.d/ghost-ci-environment.conf" ]]',
                'sudo systemctl stop "user@$TEST_UID.service"',
                'sudo loginctl disable-linger "$TEST_USER"',
                'sudo systemctl stop "user-runtime-dir@$TEST_UID.service"',
                'sudo unlink -- "$override_file"',
                'sudo rmdir -- "$override_dir"',
                'sudo systemctl daemon-reload',
                'sudo userdel --remove "$TEST_USER"',
            ],
            "manager cleanup",
            failures,
        )
        require_order(
            cleanup,
            [
                'sudo loginctl disable-linger "$TEST_USER"',
                'sudo systemctl stop "user@$TEST_UID.service"',
                'sudo systemctl stop "user-runtime-dir@$TEST_UID.service"',
                'sudo unlink -- "$override_file"',
                'sudo rmdir -- "$override_dir"',
                'sudo systemctl daemon-reload',
                'sudo userdel --remove "$TEST_USER"',
            ],
            "manager cleanup",
            failures,
        )

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
