#!/usr/bin/python

"""Copy a checksummed release inventory into a root-only immutable snapshot."""

from __future__ import annotations

import hashlib
import os
import pwd
import re
import stat
import sys
import time
from typing import NoReturn


NAME = r"[A-Za-z0-9@._+:-]+"
EXPECTED = {
    "source": re.compile(rf"ghost-{NAME}\.tar\.gz"),
    "runtime": re.compile(rf"ghost-runtime-{NAME}-linux-x86_64\.tar\.zst"),
    "runtime_sha": re.compile(
        rf"ghost-runtime-{NAME}-linux-x86_64\.tar\.zst\.sha256"
    ),
    "metadata": re.compile(r"RELEASE-METADATA\.json"),
}
MANIFEST_LINE = re.compile(r"([0-9a-f]{64})  ([A-Za-z0-9@._+:-]+)")
OPEN_DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
OPEN_REGULAR = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


def die(message: str) -> NoReturn:
    raise RuntimeError(message)


def directory_identity(
    fd: int,
    *,
    device: int,
    inode: int,
    uid: int,
    gid: int,
    mode: int,
    label: str,
) -> None:
    info = os.fstat(fd)
    if not stat.S_ISDIR(info.st_mode):
        die(f"{label} is not a directory")
    actual = (info.st_dev, info.st_ino, info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
    expected = (device, inode, uid, gid, mode)
    if actual != expected:
        die(f"{label} identity changed")


def opened_child_identity(
    parent_fd: int,
    child_fd: int,
    name: str,
    *,
    uid: int,
    gid: int,
    mode: int,
    label: str,
) -> tuple[int, int]:
    opened = os.fstat(child_fd)
    live = os.stat(name, dir_fd=parent_fd, follow_symlinks=False)
    expected = (opened.st_dev, opened.st_ino, uid, gid, mode)
    for info in (opened, live):
        actual = (
            info.st_dev,
            info.st_ino,
            info.st_uid,
            info.st_gid,
            stat.S_IMODE(info.st_mode),
        )
        if not stat.S_ISDIR(info.st_mode) or actual != expected:
            die(f"{label} identity changed")
    return opened.st_dev, opened.st_ino


def stable_regular(fd: int, before: os.stat_result, label: str) -> None:
    after = os.fstat(fd)
    fields = (
        "st_dev",
        "st_ino",
        "st_mode",
        "st_nlink",
        "st_size",
        "st_mtime_ns",
        "st_ctime_ns",
    )
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
        die(f"{label} is not a single-link regular file")
    if any(getattr(before, field) != getattr(after, field) for field in fields):
        die(f"{label} changed while being sealed")


def open_regular(directory_fd: int, name: str) -> tuple[int, os.stat_result]:
    fd = os.open(name, OPEN_REGULAR, dir_fd=directory_fd)
    try:
        before = os.fstat(fd)
        if (
            not stat.S_ISREG(before.st_mode)
            or before.st_nlink != 1
            or stat.S_IMODE(before.st_mode) != 0o644
        ):
            die(f"{name} is not a mode-0644 single-link regular file")
    except BaseException:
        os.close(fd)
        raise
    return fd, before


def read_regular(directory_fd: int, name: str) -> bytes:
    fd, before = open_regular(directory_fd, name)
    try:
        chunks: list[bytes] = []
        while chunk := os.read(fd, 1024 * 1024):
            chunks.append(chunk)
        stable_regular(fd, before, name)
        return b"".join(chunks)
    finally:
        os.close(fd)


def test_pause(name: str) -> None:
    if name != os.environ.get("GHOST_CI_SEAL_TEST_TARGET"):
        return
    ready = os.environ.get("GHOST_CI_SEAL_TEST_READY")
    proceed = os.environ.get("GHOST_CI_SEAL_TEST_CONTINUE")
    if not ready or not proceed:
        die("incomplete seal test hook")
    fd = os.open(ready, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    os.close(fd)
    deadline = time.monotonic() + 10
    while not os.path.exists(proceed):
        if time.monotonic() >= deadline:
            die("seal test hook timed out")
        time.sleep(0.01)


def copy_regular(
    source_fd: int, destination_fd: int, name: str, expected_sha: str
) -> None:
    input_fd, before = open_regular(source_fd, name)
    output_fd = -1
    try:
        test_pause(name)
        output_fd = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=destination_fd,
        )
        digest = hashlib.sha256()
        while chunk := os.read(input_fd, 1024 * 1024):
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                written = os.write(output_fd, view)
                view = view[written:]
        os.fsync(output_fd)
        os.fchmod(output_fd, 0o444)
        stable_regular(input_fd, before, name)
        if digest.hexdigest() != expected_sha:
            die(f"{name} does not match SHA256SUMS")
    except BaseException:
        if output_fd >= 0:
            os.close(output_fd)
            output_fd = -1
        try:
            os.unlink(name, dir_fd=destination_fd)
        except FileNotFoundError:
            pass
        raise
    finally:
        if output_fd >= 0:
            os.close(output_fd)
        os.close(input_fd)


def parse_manifest(data: bytes) -> dict[str, str]:
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise RuntimeError("SHA256SUMS is not UTF-8") from error
    result: dict[str, str] = {}
    for line in lines:
        match = MANIFEST_LINE.fullmatch(line)
        if match is None or match.group(2) in result:
            die("SHA256SUMS contains an invalid or duplicate entry")
        result[match.group(2)] = match.group(1)
    if not result:
        die("SHA256SUMS is empty")
    return result


def validate_names(names: set[str]) -> None:
    remaining = set(names)
    for label, pattern in EXPECTED.items():
        matches = {name for name in remaining if pattern.fullmatch(name)}
        if len(matches) != 1:
            die(f"release inventory requires exactly one {label}")
        remaining -= matches
    if remaining:
        die(f"release inventory has unexpected entries: {sorted(remaining)!r}")


def main() -> int:
    if os.geteuid() != 0:
        die("artifact sealing must run as root")
    if len(sys.argv) != 9:
        die(
            "usage: seal-ci-release-artifacts.py <builder> <outer> "
            "<outer-dev> <outer-ino> <out-dev> <out-ino> "
            "<sealed-dev> <sealed-ino>"
        )
    _, builder, outer, outer_dev, outer_ino, out_dev, out_ino, sealed_dev, sealed_ino = (
        sys.argv
    )
    if not re.fullmatch(r"[a-z_][a-z0-9_-]*", builder):
        die("invalid builder user")
    if not re.fullmatch(r"/var/tmp/ghost-ci-release\.[A-Za-z0-9]+", outer):
        die("invalid release outer path")
    account = pwd.getpwnam(builder)
    identities = [
        int(value)
        for value in (outer_dev, outer_ino, out_dev, out_ino, sealed_dev, sealed_ino)
    ]
    outer_fd = os.open(outer, OPEN_DIR)
    out_fd = candidate_fd = sealed_fd = -1
    created: list[str] = []
    try:
        directory_identity(
            outer_fd,
            device=identities[0],
            inode=identities[1],
            uid=0,
            gid=0,
            mode=0o711,
            label="release outer",
        )
        out_fd = os.open("out", OPEN_DIR, dir_fd=outer_fd)
        sealed_fd = os.open("sealed", OPEN_DIR, dir_fd=outer_fd)
        directory_identity(
            out_fd,
            device=identities[2],
            inode=identities[3],
            uid=account.pw_uid,
            gid=account.pw_gid,
            mode=0o700,
            label="release out",
        )
        directory_identity(
            sealed_fd,
            device=identities[4],
            inode=identities[5],
            uid=0,
            gid=0,
            mode=0o700,
            label="sealed upload",
        )
        if os.listdir(sealed_fd):
            die("sealed upload directory is not empty")
        candidate_fd = os.open("public-candidate", OPEN_DIR, dir_fd=out_fd)
        candidate_identity = opened_child_identity(
            out_fd,
            candidate_fd,
            "public-candidate",
            uid=account.pw_uid,
            gid=account.pw_gid,
            mode=0o755,
            label="public candidate",
        )
        source_names = set(os.listdir(candidate_fd))
        if "SHA256SUMS" not in source_names:
            die("release inventory has no SHA256SUMS")
        manifest_data = read_regular(candidate_fd, "SHA256SUMS")
        manifest = parse_manifest(manifest_data)
        signature_names = source_names & {"SHA256SUMS.sig"}
        if source_names != set(manifest) | {"SHA256SUMS"} | signature_names:
            die("SHA256SUMS does not cover the exact release inventory")
        validate_names(set(manifest))
        for name in sorted(manifest):
            copy_regular(candidate_fd, sealed_fd, name, manifest[name])
            created.append(name)
        if signature_names:
            signature_data = read_regular(candidate_fd, "SHA256SUMS.sig")
            if not signature_data:
                die("detached SHA256SUMS signature is empty")
            copy_regular(
                candidate_fd,
                sealed_fd,
                "SHA256SUMS.sig",
                hashlib.sha256(signature_data).hexdigest(),
            )
            created.append("SHA256SUMS.sig")
        manifest_fd = os.open(
            "SHA256SUMS",
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
            dir_fd=sealed_fd,
        )
        created.append("SHA256SUMS")
        try:
            view = memoryview(manifest_data)
            while view:
                written = os.write(manifest_fd, view)
                view = view[written:]
            os.fsync(manifest_fd)
            os.fchmod(manifest_fd, 0o444)
        finally:
            os.close(manifest_fd)
        if set(os.listdir(candidate_fd)) != source_names:
            die("release inventory changed while being sealed")
        if read_regular(candidate_fd, "SHA256SUMS") != manifest_data:
            die("SHA256SUMS changed while being sealed")
        if opened_child_identity(
            out_fd,
            candidate_fd,
            "public-candidate",
            uid=account.pw_uid,
            gid=account.pw_gid,
            mode=0o755,
            label="public candidate",
        ) != candidate_identity:
            die("public candidate identity changed")
        directory_identity(
            out_fd,
            device=identities[2],
            inode=identities[3],
            uid=account.pw_uid,
            gid=account.pw_gid,
            mode=0o700,
            label="release out",
        )
        os.fsync(sealed_fd)
        os.fchmod(sealed_fd, 0o500)
        os.fsync(outer_fd)
    except BaseException:
        for name in created:
            try:
                os.unlink(name, dir_fd=sealed_fd)
            except FileNotFoundError:
                pass
        raise
    finally:
        for fd in (sealed_fd, candidate_fd, out_fd, outer_fd):
            if fd >= 0:
                os.close(fd)
    print("sealed release artifact inventory passed")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"artifact sealing failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
