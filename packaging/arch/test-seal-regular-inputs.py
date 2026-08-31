#!/usr/bin/python

from __future__ import annotations

import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import tempfile
from types import ModuleType


TEST = Path(__file__).resolve()
SCRIPT = TEST.with_name("seal-ci-release-artifacts.py")


def load_sealer() -> ModuleType:
    spec = importlib.util.spec_from_file_location("ghost_release_sealer", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError("could not load release sealer")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def probe(operation: str, directory: Path, name: str) -> int:
    sealer = load_sealer()
    source_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
    destination_fd = -1
    try:
        if operation == "read":
            sealer.read_regular(source_fd, name)
        else:
            destination = directory.parent / "sealed"
            destination.mkdir(exist_ok=True)
            destination_fd = os.open(destination, os.O_RDONLY | os.O_DIRECTORY)
            sealer.copy_regular(source_fd, destination_fd, name, "0" * 64)
    except (OSError, RuntimeError) as error:
        print(error, file=sys.stderr)
        return 1
    finally:
        if destination_fd >= 0:
            os.close(destination_fd)
        os.close(source_fd)
    return 0


def assert_rejected(
    operation: str, directory: Path, name: str, *, regular_check: bool = True
) -> None:
    try:
        result = subprocess.run(
            [sys.executable, str(TEST), operation, str(directory), name],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
            timeout=2,
        )
    except subprocess.TimeoutExpired as error:
        raise AssertionError(f"sealer blocked opening {name}") from error
    if result.returncode == 0:
        raise AssertionError(f"sealer accepted unsafe input {name}")
    if regular_check and "mode-0644 single-link regular file" not in result.stderr:
        raise AssertionError(f"sealer did not reject {name} at open: {result.stderr}")


def main() -> None:
    if len(sys.argv) == 4:
        raise SystemExit(probe(sys.argv[1], Path(sys.argv[2]), sys.argv[3]))

    with tempfile.TemporaryDirectory(prefix="ghost-sealer-inputs.") as temporary:
        root = Path(temporary)
        candidate = root / "candidate"
        candidate.mkdir()
        regular = candidate / "regular"
        regular.write_text("fixture\n")
        regular.chmod(0o644)
        sealer = load_sealer()
        directory_fd = os.open(candidate, os.O_RDONLY | os.O_DIRECTORY)
        try:
            assert sealer.read_regular(directory_fd, regular.name) == b"fixture\n"
        finally:
            os.close(directory_fd)

        for name, operation in (
            ("SHA256SUMS", "read"),
            ("SHA256SUMS.sig", "read"),
            ("ghost-1.2.3.tar.gz", "copy"),
        ):
            path = candidate / name
            os.mkfifo(path, 0o644)
            assert_rejected(operation, candidate, name)
            path.unlink()

        wrong_mode = candidate / "wrong-mode"
        wrong_mode.write_text("fixture\n")
        wrong_mode.chmod(0o600)
        assert_rejected("read", candidate, wrong_mode.name)

        hardlink = candidate / "hardlink"
        os.link(regular, hardlink)
        assert_rejected("read", candidate, hardlink.name)

        symlink = candidate / "symlink"
        symlink.symlink_to(regular.name)
        assert_rejected("read", candidate, symlink.name, regular_check=False)

    print("release sealer regular-input regression passed")


if __name__ == "__main__":
    main()
