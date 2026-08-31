"""Focused fixtures for release workflow input and source-run validation."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("validate-release-workflow.py").resolve()
SHA = "1" * 40
REPOSITORY = "ferdousbhai/ghost"


class WorkflowValidationFixtures(unittest.TestCase):
    def invoke(
        self,
        arguments: list[str],
        *,
        success: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        completed = subprocess.run(
            [sys.executable, str(SCRIPT), *arguments],
            text=True,
            capture_output=True,
            check=False,
        )
        if success and completed.returncode != 0:
            self.fail(f"validator failed unexpectedly: {completed.stderr}")
        if not success and completed.returncode == 0:
            self.fail("validator accepted an invalid fixture")
        return completed

    def test_mode_specific_release_id_and_canonical_identity(self) -> None:
        common = [
            "--source-run-id",
            "123",
            "--source-sha",
            SHA,
            "--version",
            "0.1.0",
        ]
        self.invoke(["inputs", "--mode", "dry-run", *common])
        self.invoke(
            [
                "inputs",
                "--mode",
                "dry-run",
                *common[:-1],
                "65535.65535.65535",
            ]
        )
        self.invoke(
            [
                "inputs",
                "--mode",
                "publish",
                *common,
                "--release-id",
                "99",
                "--candidate-commit",
                SHA,
            ]
        )
        invalid = [
            ["inputs", "--mode", "stage", *common, "--release-id", "99"],
            ["inputs", "--mode", "stage", *common, "--candidate-commit", SHA],
            ["inputs", "--mode", "publish", *common],
            [
                "inputs",
                "--mode",
                "publish",
                *common,
                "--release-id",
                "99",
            ],
            [
                "inputs",
                "--mode",
                "publish",
                *common,
                "--release-id",
                "99",
                "--candidate-commit",
                "2" * 39,
            ],
            ["inputs", "--mode", "dry-run", *common, "--version", "01.0.0"],
            ["inputs", "--mode", "dry-run", *common, "--version", "65536.0.0"],
            ["inputs", "--mode", "dry-run", *common, "--destination", "bad"],
        ]
        for command in invalid:
            with self.subTest(command=command):
                self.invoke(command, success=False)

    def test_oversized_numeric_inputs_fail_without_tracebacks(self) -> None:
        huge = "9" * 5000
        base = [
            "inputs",
            "--mode",
            "dry-run",
            "--source-run-id",
            "123",
            "--source-sha",
            SHA,
            "--version",
            "0.1.0",
        ]
        commands = [
            [*base[:4], huge, *base[5:]],
            [*base[:-1], f"{huge}.0.0"],
            [
                *base[:2],
                "publish",
                *base[3:],
                "--release-id",
                huge,
                "--candidate-commit",
                SHA,
            ],
        ]
        for command in commands:
            with self.subTest(argument=command[-1][:32]):
                result = self.invoke(command, success=False)
                self.assertNotIn("Traceback", result.stderr)

    def test_destination_must_be_explicit_and_unambiguous(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ghost-destination-") as temporary:
            output = Path(temporary) / "output"
            base = ["destination", "--github-output", str(output)]
            self.invoke(base, success=False)
            self.invoke(
                [*base, "--input-repository", "ferdousbhai/ghost-releases"],
                success=False,
            )
            self.assertFalse(output.exists())
            self.invoke(
                [
                    *base,
                    "--input-repository",
                    "ferdousbhai/releases",
                    "--configured-repository",
                    "ferdousbhai/other",
                ],
                success=False,
            )
            self.invoke(
                [
                    *base,
                    "--configured-repository",
                    "ferdousbhai/ghost-releases",
                ]
            )
            self.assertEqual(
                output.read_text(encoding="utf-8").splitlines(),
                [
                    "destination=ferdousbhai/ghost-releases",
                    "owner=ferdousbhai",
                    "repository=ghost-releases",
                ],
            )

    def test_source_run_is_exact_successful_master_push(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ghost-source-run-") as temporary:
            root = Path(temporary)
            response = root / "run.json"
            output = root / "output"
            run = {
                "id": 123,
                "head_sha": SHA,
                "status": "completed",
                "conclusion": "success",
                "event": "push",
                "head_branch": "master",
                "repository": {"full_name": REPOSITORY},
                "path": ".github/workflows/arch-package.yml",
                "run_attempt": 2,
            }
            response.write_text(json.dumps(run), encoding="utf-8")
            command = [
                "source-run",
                "--run-json",
                str(response),
                "--source-repository",
                REPOSITORY,
                "--source-run-id",
                "123",
                "--source-sha",
                SHA,
                "--github-output",
                str(output),
            ]
            self.invoke(command)
            self.assertEqual(
                output.read_text(encoding="utf-8").splitlines(),
                [
                    "run_attempt=2",
                    (
                        "workflow_ref=ferdousbhai/ghost/.github/workflows/"
                        "arch-package.yml@refs/heads/master"
                    ),
                ],
            )
            for key, value in (
                ("event", "pull_request"),
                ("head_branch", "topic"),
                ("conclusion", "failure"),
                ("path", ".github/workflows/other.yml"),
                ("run_attempt", 65536),
            ):
                invalid = dict(run)
                invalid[key] = value
                response.write_text(json.dumps(invalid), encoding="utf-8")
                with self.subTest(key=key):
                    self.invoke(command, success=False)

            oversized = list(command)
            oversized[oversized.index("123")] = "9" * 5000
            result = self.invoke(oversized, success=False)
            self.assertNotIn("Traceback", result.stderr)

    def test_trusted_workflow_is_current_protected_master(self) -> None:
        with tempfile.TemporaryDirectory(prefix="ghost-trusted-workflow-") as temporary:
            root = Path(temporary)
            branch_path = root / "branch.json"
            ref_path = root / "ref.json"
            output = root / "output"
            branch = {
                "name": "master",
                "protected": True,
                "commit": {"sha": SHA},
            }
            reference = {
                "ref": "refs/heads/master",
                "object": {"type": "commit", "sha": SHA},
            }
            branch_path.write_text(json.dumps(branch), encoding="utf-8")
            ref_path.write_text(json.dumps(reference), encoding="utf-8")
            command = [
                "trusted-run",
                "--repository",
                REPOSITORY,
                "--workflow-ref",
                f"{REPOSITORY}/.github/workflows/release.yml@refs/heads/master",
                "--workflow-sha",
                SHA,
                "--dispatch-sha",
                SHA,
                "--checkout-sha",
                SHA,
                "--branch-json",
                str(branch_path),
                "--ref-json",
                str(ref_path),
                "--github-output",
                str(output),
            ]
            self.invoke(command)
            self.assertEqual(output.read_text(encoding="utf-8"), f"trusted_sha={SHA}\n")

            branch["protected"] = False
            branch_path.write_text(json.dumps(branch), encoding="utf-8")
            self.invoke(command, success=False)
            branch["protected"] = True
            branch_path.write_text(json.dumps(branch), encoding="utf-8")
            wrong_dispatch = list(command)
            wrong_dispatch[8] = "2" * 40
            self.invoke(wrong_dispatch, success=False)
            self.invoke(
                [
                    value.replace("refs/heads/master", "refs/heads/topic")
                    if "release.yml@" in value
                    else value
                    for value in command
                ],
                success=False,
            )


if __name__ == "__main__":
    unittest.main(verbosity=2)
