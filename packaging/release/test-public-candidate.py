#!/usr/bin/python

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "packaging/release/public-candidate.py"
VERSION = "1.2.3"
COMMIT = "a" * 40
EPOCH = 123456789
REPOSITORY = "example/ghost-releases"
WORKFLOW_REPOSITORY = "example/private-ghost"
WORKFLOW_REF = "example/private-ghost/.github/workflows/release.yml@refs/heads/master"


def add_text(archive: tarfile.TarFile, name: str, text: str, mode: int = 0o644) -> None:
    data = text.encode()
    info = tarfile.TarInfo(name)
    info.size = len(data)
    info.mode = mode
    info.mtime = EPOCH
    archive.addfile(info, __import__("io").BytesIO(data))


def make_archives(work: Path) -> dict[str, Path]:
    source = work / f"ghost-{VERSION}.tar.gz"
    with tarfile.open(source, "w:gz") as archive:
        add_text(
            archive,
            f"ghost-{VERSION}/RELEASE-SOURCE.MANIFEST",
            "\n".join(
                [
                    "format=ghost-release-source/v1",
                    f"version={VERSION}",
                    f"source_commit={COMMIT}",
                    f"source_date_epoch={EPOCH}",
                    "",
                ]
            ),
        )
        add_text(archive, f"ghost-{VERSION}/LICENSE", "fixture\n")

    runtime = work / f"ghost-runtime-{VERSION}-linux-x86_64.tar.zst"
    runtime_prefix = f"ghost-runtime-{VERSION}-linux-x86_64"
    with tarfile.open(runtime, "w:zst") as archive:
        add_text(
            archive,
            f"{runtime_prefix}/MANIFEST",
            "\n".join(
                [
                    "format=ghost-runtime-source/v3",
                    f"version={VERSION}",
                    "os=linux",
                    "arch=x86_64",
                    f"source_commit={COMMIT}",
                    f"source_date_epoch={EPOCH}",
                    "bun_build_version=1.3.14",
                    "bun_runtime_min=1.3.14",
                    "bundle_target=bun",
                    "",
                ]
            ),
        )
        add_text(archive, f"{runtime_prefix}/bin/ghost", "fixture\n", 0o755)
    runtime_sha = hashlib.sha256(runtime.read_bytes()).hexdigest()
    runtime_checksum = work / f"{runtime.name}.sha256"
    runtime_checksum.write_text(f"{runtime_sha}  {runtime.name}\n")

    return {
        "source": source,
        "runtime": runtime,
        "runtime_checksum": runtime_checksum,
    }


def identity_arguments() -> list[str]:
    return [
        "--version",
        VERSION,
        "--source-tag",
        f"v{VERSION}",
        "--source-commit",
        COMMIT,
        "--source-date-epoch",
        str(EPOCH),
        "--workflow-repository",
        WORKFLOW_REPOSITORY,
        "--workflow-ref",
        WORKFLOW_REF,
        "--run-id",
        "4242",
        "--run-attempt",
        "1",
    ]


def creation_arguments(inputs: dict[str, Path], output: Path) -> list[str]:
    arguments = [
        "create",
        "--output",
        str(output),
        "--source-archive",
        str(inputs["source"]),
        "--runtime-archive",
        str(inputs["runtime"]),
        "--runtime-checksum",
        str(inputs["runtime_checksum"]),
        *identity_arguments(),
    ]
    for name in ("bun", "git", "makepkg", "pnpm", "python", "zstd"):
        arguments.extend(["--build-tool", f"{name}=fixture-{name}"])
    arguments.extend(["--action", f"actions/checkout={'b' * 40}"])
    arguments.extend(["--container", "arch=archlinux:base-devel@sha256:fixture"])
    return arguments


def run(
    arguments: list[str], *, repository: str | None = REPOSITORY, success: bool = True
) -> subprocess.CompletedProcess[str]:
    environment = os.environ.copy()
    if repository is None:
        environment.pop("GHOST_RELEASE_REPOSITORY", None)
    else:
        environment["GHOST_RELEASE_REPOSITORY"] = repository
    result = subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        env=environment,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    if (result.returncode == 0) != success:
        raise AssertionError(result.stdout)
    return result


def verify(candidate: Path, *, repository: str = REPOSITORY) -> None:
    result = run(
        ["verify", "--candidate", str(candidate), *identity_arguments()],
        repository=repository,
    )
    assert "Verified public release candidate:" in result.stdout


def main() -> None:
    work = Path(tempfile.mkdtemp(prefix="ghost-public-candidate."))
    try:
        inputs = make_archives(work)
        inputs["source"].chmod(0o600)
        candidate = work / "candidate"
        arguments = creation_arguments(inputs, candidate)

        missing = run(arguments, repository=None, success=False)
        assert "invalid GHOST_RELEASE_REPOSITORY" in missing.stdout
        invalid = run(arguments, repository="private-default", success=False)
        assert "invalid GHOST_RELEASE_REPOSITORY" in invalid.stdout

        created = run(arguments)
        assert "Created public release candidate:" in created.stdout
        verify(candidate)
        names = sorted(path.name for path in candidate.iterdir())
        assert stat.S_IMODE(candidate.stat().st_mode) == 0o755
        assert all(
            stat.S_IMODE(path.stat().st_mode) == 0o644
            for path in candidate.iterdir()
        )
        assert names == [
            "RELEASE-METADATA.json",
            "SHA256SUMS",
            f"ghost-{VERSION}.tar.gz",
            f"ghost-runtime-{VERSION}-linux-x86_64.tar.zst",
            f"ghost-runtime-{VERSION}-linux-x86_64.tar.zst.sha256",
        ]
        sums = candidate.joinpath("SHA256SUMS").read_text()
        assert "SHA256SUMS" not in sums and ".pkg.tar" not in sums
        metadata = json.loads(candidate.joinpath("RELEASE-METADATA.json").read_text())
        assert metadata["format"] == "ghost-release-candidate/v1"
        assert metadata["release"] == {
            "repository": REPOSITORY,
            "tag": f"v{VERSION}",
            "version": VERSION,
        }
        assert metadata["source"] == {"commit": COMMIT, "date_epoch": EPOCH}
        assert metadata["provenance"]["workflow"]["run_id"] == 4242

        second = work / "candidate-second"
        run(creation_arguments(inputs, second))
        assert names == sorted(path.name for path in second.iterdir())
        for name in names:
            assert candidate.joinpath(name).read_bytes() == second.joinpath(name).read_bytes()
        repeated = run(arguments)
        assert "already matches" in repeated.stdout

        collision = work / "collision"
        shutil.copytree(candidate, collision)
        collision.joinpath("RELEASE-METADATA.json").write_text("different\n")
        rejected = run(creation_arguments(inputs, collision), success=False)
        assert "same-name different bytes: RELEASE-METADATA.json" in rejected.stdout

        bad_directory_mode = work / "bad-directory-mode"
        shutil.copytree(candidate, bad_directory_mode)
        bad_directory_mode.chmod(0o700)
        rejected = run(
            ["verify", "--candidate", str(bad_directory_mode), *identity_arguments()],
            success=False,
        )
        assert "candidate directory is not mode 0755" in rejected.stdout

        bad_file_mode = work / "bad-file-mode"
        shutil.copytree(candidate, bad_file_mode)
        bad_file_mode.joinpath("RELEASE-METADATA.json").chmod(0o600)
        rejected = run(
            ["verify", "--candidate", str(bad_file_mode), *identity_arguments()],
            success=False,
        )
        assert "candidate file is not mode 0644" in rejected.stdout
        rejected = run(
            creation_arguments(inputs, bad_file_mode),
            success=False,
        )
        assert "candidate file is not mode 0644" in rejected.stdout

        unexpected = work / "unexpected"
        shutil.copytree(candidate, unexpected)
        unexpected.joinpath("ghost-dev-fixture.pkg.tar.zst").write_text("dev\n")
        rejected = run(
            ["verify", "--candidate", str(unexpected), *identity_arguments()],
            success=False,
        )
        assert "candidate inventory mismatch" in rejected.stdout

        signature = work / "detached-signature"
        signature.write_text("detached fixture\n")
        signature.chmod(0o600)
        signed = work / "signed"
        signed_arguments = creation_arguments(inputs, signed)
        signed_arguments.extend(["--checksum-signature", str(signature)])
        run(signed_arguments)
        verify(signed)
        assert stat.S_IMODE(signed.joinpath("SHA256SUMS.sig").stat().st_mode) == 0o644
        assert "SHA256SUMS.sig" not in signed.joinpath("SHA256SUMS").read_text()

        linked = work / "linked"
        shutil.copytree(candidate, linked)
        linked.joinpath(inputs["runtime_checksum"].name).unlink()
        linked.joinpath(inputs["runtime_checksum"].name).symlink_to("SHA256SUMS")
        rejected = run(
            ["verify", "--candidate", str(linked), *identity_arguments()],
            success=False,
        )
        assert "symlink or special file" in rejected.stdout

        mismatched_tag = identity_arguments()
        mismatched_tag[mismatched_tag.index(f"v{VERSION}")] = "v9.9.9"
        rejected = run(
            ["verify", "--candidate", str(candidate), *mismatched_tag], success=False
        )
        assert "does not match version" in rejected.stdout
        rejected = run(
            ["verify", "--candidate", str(candidate), *identity_arguments()],
            repository="other/ghost-releases",
            success=False,
        )
        assert "RELEASE-METADATA.json release does not match" in rejected.stdout

        checksum_bad = work / "checksum-bad"
        shutil.copytree(candidate, checksum_bad)
        checksum_bad.joinpath(inputs["runtime_checksum"].name).write_text(
            f"{'0' * 64}  {inputs['runtime'].name}\n"
        )
        rejected = run(
            ["verify", "--candidate", str(checksum_bad), *identity_arguments()],
            success=False,
        )
        assert "RELEASE-METADATA.json artifacts does not match" in rejected.stdout

        source_link = work / "source-link.tar.gz"
        source_link.symlink_to(inputs["source"])
        linked_arguments = creation_arguments(inputs, work / "linked-input-output")
        linked_arguments[linked_arguments.index(str(inputs["source"]))] = str(source_link)
        rejected = run(linked_arguments, success=False)
        assert "not a single-link regular file" in rejected.stdout

        duplicate_tool = creation_arguments(inputs, work / "duplicate-tool")
        duplicate_tool.extend(["--build-tool", "bun=duplicate"])
        rejected = run(duplicate_tool, success=False)
        assert "duplicate build tool name: bun" in rejected.stdout

        print("Public release candidate dry-run fixtures passed")
    finally:
        shutil.rmtree(work)


if __name__ == "__main__":
    main()
