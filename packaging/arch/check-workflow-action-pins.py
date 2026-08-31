#!/usr/bin/env python3

"""Require immutable references at semantic GitHub Actions uses locations."""

from __future__ import annotations

import re
import sys
from pathlib import Path

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode


PINNED_REMOTE_ACTION = re.compile(
    r"^[^/@\s]+/[^/@\s]+(?:/[^@\s]+)?@[0-9a-fA-F]{40}$"
)
PINNED_DOCKER_ACTION = re.compile(
    r"^docker://[^@\s]+@sha256:[0-9a-fA-F]{64}$"
)


def values_for(node: MappingNode, key: str) -> list[Node]:
    return [
        value
        for candidate, value in node.value
        if isinstance(candidate, ScalarNode) and candidate.value == key
    ]


class RepositoryChecker:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.errors: list[str] = []
        self.workflows: list[Path] = []
        self.workflow_targets: set[Path] = set()
        self.action_state: dict[Path, str] = {}
        self.action_stack: list[Path] = []

    def error(self, path: Path, node: Node | None, message: str) -> None:
        line = f":{node.start_mark.line + 1}" if node is not None else ""
        self.errors.append(f"{path}{line}: {message}")

    def parse(self, path: Path) -> Node | None:
        try:
            document = yaml.compose(
                path.read_text(encoding="utf-8"), Loader=yaml.SafeLoader
            )
        except (OSError, UnicodeError, yaml.YAMLError) as error:
            self.error(path, None, f"YAML cannot be checked safely: {error}")
            return None
        if document is None:
            self.error(path, None, "YAML document is empty")
        return document

    def discover_workflows(self) -> None:
        directory = self.root / ".github/workflows"
        candidates = sorted((*directory.glob("*.yml"), *directory.glob("*.yaml")))
        if not candidates:
            self.error(directory, None, "no workflow YAML files found")
            return
        for path in candidates:
            try:
                target = path.resolve(strict=True)
            except OSError as error:
                self.error(path, None, f"workflow path cannot be resolved: {error}")
                continue
            if not target.is_relative_to(self.root):
                self.error(path, None, "workflow resolves outside the repository")
                continue
            if not target.is_file():
                self.error(path, None, "workflow is not a regular file")
                continue
            self.workflows.append(path)
            self.workflow_targets.add(target)

    def check(self) -> list[str]:
        self.discover_workflows()
        for workflow in self.workflows:
            self.check_workflow(workflow)
        return self.errors

    def check_workflow(self, path: Path) -> None:
        document = self.parse(path)
        if document is None:
            return
        if not isinstance(document, MappingNode):
            self.error(path, document, "workflow document is not a mapping")
            return
        for jobs in values_for(document, "jobs"):
            if not isinstance(jobs, MappingNode):
                self.error(path, jobs, "workflow jobs is not a mapping")
                continue
            for _job_name, job in jobs.value:
                if not isinstance(job, MappingNode):
                    self.error(path, job, "workflow job is not a mapping")
                    continue
                for reference in values_for(job, "uses"):
                    self.check_reference(path, reference, reusable_workflow=True)
                for steps in values_for(job, "steps"):
                    self.check_steps(path, steps, allow_parallel=True)

    def check_steps(
        self,
        path: Path,
        steps: Node,
        *,
        allow_parallel: bool,
        active: set[int] | None = None,
    ) -> None:
        if not isinstance(steps, SequenceNode):
            self.error(path, steps, "steps is not a sequence")
            return
        if active is None:
            active = set()
        identity = id(steps)
        if identity in active:
            self.error(path, steps, "parallel step sequence cycle")
            return
        active.add(identity)
        for step in steps.value:
            if not isinstance(step, MappingNode):
                self.error(path, step, "step is not a mapping")
                continue
            for reference in values_for(step, "uses"):
                self.check_reference(path, reference, reusable_workflow=False)
            if allow_parallel:
                for parallel in values_for(step, "parallel"):
                    self.check_steps(
                        path, parallel, allow_parallel=True, active=active
                    )
        active.remove(identity)

    def check_reference(
        self, path: Path, node: Node, *, reusable_workflow: bool
    ) -> None:
        if not isinstance(node, ScalarNode):
            self.error(path, node, "uses reference is not a scalar")
            return
        reference = node.value
        if reference.startswith("$/") and "@" in reference:
            self.error(path, node, "$/ uses reference must not include an @ref suffix")
            return
        if reference.startswith(("./", "$/")):
            if reusable_workflow:
                self.check_local_workflow(path, node, reference)
            else:
                self.check_local_action(path, node, reference)
            return
        if not reusable_workflow and PINNED_DOCKER_ACTION.fullmatch(reference):
            return
        if reference.startswith("docker://"):
            self.error(
                path,
                node,
                "Docker uses reference must end in sha256: plus a 64-character digest",
            )
            return
        if not PINNED_REMOTE_ACTION.fullmatch(reference):
            self.error(
                path,
                node,
                "remote uses reference must end in a 40-character commit SHA: "
                f"{reference!r}",
            )

    def resolve_local(self, path: Path, node: Node, reference: str) -> Path | None:
        try:
            target = (self.root / reference[2:]).resolve(strict=True)
        except OSError as error:
            self.error(path, node, f"local uses path cannot be resolved: {error}")
            return None
        if not target.is_relative_to(self.root):
            self.error(path, node, "local uses path resolves outside the repository")
            return None
        return target

    def check_local_workflow(self, path: Path, node: Node, reference: str) -> None:
        target = self.resolve_local(path, node, reference)
        if target is not None and target not in self.workflow_targets:
            self.error(
                path,
                node,
                "local reusable workflow is not part of the repository workflow scan",
            )

    def check_local_action(self, path: Path, node: Node, reference: str) -> None:
        directory = self.resolve_local(path, node, reference)
        if directory is None:
            return
        if not directory.is_dir():
            self.error(path, node, "local action path is not a directory")
            return
        manifests = [
            manifest
            for name in ("action.yml", "action.yaml")
            if (manifest := directory / name).is_file()
        ]
        if len(manifests) != 1:
            self.error(
                path,
                node,
                "local action must contain exactly one action.yml or action.yaml",
            )
            return
        try:
            manifest = manifests[0].resolve(strict=True)
        except OSError as error:
            self.error(path, node, f"local action manifest cannot be resolved: {error}")
            return
        if not manifest.is_relative_to(self.root):
            self.error(
                path, node, "local action manifest resolves outside the repository"
            )
            return
        self.check_action(manifest, path, node)

    def check_action(self, manifest: Path, source: Path, reference: Node) -> None:
        state = self.action_state.get(manifest)
        if state == "done":
            return
        if state == "active":
            start = self.action_stack.index(manifest)
            cycle = self.action_stack[start:] + [manifest]
            rendered = " -> ".join(
                str(path.relative_to(self.root)) for path in cycle
            )
            self.error(source, reference, f"local composite action cycle: {rendered}")
            return

        self.action_state[manifest] = "active"
        self.action_stack.append(manifest)
        document = self.parse(manifest)
        if isinstance(document, MappingNode):
            for runs in values_for(document, "runs"):
                if not isinstance(runs, MappingNode):
                    self.error(manifest, runs, "action runs is not a mapping")
                    continue
                using = values_for(runs, "using")
                composite = any(
                    isinstance(value, ScalarNode) and value.value == "composite"
                    for value in using
                )
                if composite:
                    steps = values_for(runs, "steps")
                    if not steps:
                        self.error(manifest, runs, "composite action has no steps")
                    for value in steps:
                        self.check_steps(manifest, value, allow_parallel=False)
        elif document is not None:
            self.error(manifest, document, "action document is not a mapping")
        self.action_stack.pop()
        self.action_state[manifest] = "done"


def main() -> int:
    if len(sys.argv) != 2:
        print(
            "usage: check-workflow-action-pins.py <repository-root>",
            file=sys.stderr,
        )
        return 2
    try:
        root = Path(sys.argv[1]).resolve(strict=True)
    except OSError as error:
        print(f"repository root cannot be resolved: {error}", file=sys.stderr)
        return 2
    if not root.is_dir():
        print(f"repository root is not a directory: {root}", file=sys.stderr)
        return 2
    errors = RepositoryChecker(root).check()
    if errors:
        print("\n".join(errors), file=sys.stderr)
        return 1
    print("GitHub Actions commit pins passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
