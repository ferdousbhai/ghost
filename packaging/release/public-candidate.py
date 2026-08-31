#!/usr/bin/python

"""Create and verify the exact stable-only public release candidate."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tarfile
import tempfile
from typing import NoReturn


FORMAT = "ghost-release-candidate/v1"
REPOSITORY = re.compile(
    r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}"
)
COMMIT = re.compile(r"[0-9a-f]{40}")
PAIR_NAME = re.compile(r"[a-z][a-z0-9_-]{0,63}")
REQUIRED_BUILD_TOOLS = {"bun", "git", "makepkg", "pnpm", "python", "zstd"}
FIXED_NAMES = {"RELEASE-METADATA.json", "SHA256SUMS"}
SIGNATURE_NAME = "SHA256SUMS.sig"
MAX_CONTROL_BYTES = 256 * 1024


class CandidateError(RuntimeError):
    pass


def die(message: str) -> NoReturn:
    raise CandidateError(message)


def validate_version(value: str) -> str:
    parts = value.split(".")
    if len(parts) != 3 or any(
        not part.isascii()
        or not part.isdecimal()
        or (len(part) > 1 and part.startswith("0"))
        for part in parts
    ):
        die(f"invalid release version: {value}")
    numbers = [int(part) for part in parts]
    if all(number == 0 for number in numbers) or any(number > 65535 for number in numbers):
        die(f"invalid release version: {value}")
    return value


def validate_repository(value: str, label: str) -> str:
    if REPOSITORY.fullmatch(value) is None:
        die(f"invalid {label}: {value}")
    return value


def validate_text(value: str, label: str, maximum: int = 512) -> str:
    if not value or len(value) > maximum or any(ord(char) < 0x20 for char in value):
        die(f"invalid {label}")
    return value


def positive_decimal(value: str, label: str) -> int:
    if not value.isascii() or not value.isdecimal() or int(value) <= 0:
        die(f"invalid {label}: {value}")
    return int(value)


def parse_pairs(
    values: list[str], label: str, *, repository_keys: bool = False, sha_values: bool = False
) -> dict[str, str]:
    result: dict[str, str] = {}
    for value in values:
        name, separator, item = value.partition("=")
        if not separator or not item:
            die(f"invalid {label} row: {value}")
        if repository_keys:
            validate_repository(name, f"{label} name")
        elif PAIR_NAME.fullmatch(name) is None:
            die(f"invalid {label} name: {name}")
        validate_text(item, f"{label} value")
        if sha_values and COMMIT.fullmatch(item) is None:
            die(f"{label} ref must be a 40-character lowercase SHA: {item}")
        if name in result:
            die(f"duplicate {label} name: {name}")
        result[name] = item
    return dict(sorted(result.items()))


def identity(info: os.stat_result) -> tuple[int, ...]:
    return (
        info.st_dev,
        info.st_ino,
        info.st_mode,
        info.st_nlink,
        info.st_size,
        info.st_mtime_ns,
        info.st_ctime_ns,
    )


def open_regular(path: Path) -> tuple[int, os.stat_result]:
    try:
        before_path = path.lstat()
    except OSError as error:
        raise CandidateError(f"cannot inspect candidate file {path}: {error}") from error
    if not stat.S_ISREG(before_path.st_mode) or before_path.st_nlink != 1:
        die(f"candidate input is not a single-link regular file: {path}")
    try:
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as error:
        raise CandidateError(f"cannot open candidate file {path}: {error}") from error
    before = os.fstat(descriptor)
    if identity(before) != identity(before_path):
        os.close(descriptor)
        die(f"candidate file identity changed before read: {path}")
    return descriptor, before


def finish_regular(path: Path, descriptor: int, before: os.stat_result) -> None:
    after = os.fstat(descriptor)
    try:
        live = path.lstat()
    except OSError as error:
        raise CandidateError(f"candidate file disappeared during read: {path}") from error
    if identity(after) != identity(before) or identity(live) != identity(before):
        die(f"candidate file changed during read: {path}")


def read_regular(path: Path, maximum: int | None = None) -> bytes:
    descriptor, before = open_regular(path)
    try:
        if maximum is not None and before.st_size > maximum:
            die(f"candidate control file is too large: {path}")
        chunks: list[bytes] = []
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                die(f"candidate file ended early: {path}")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            die(f"candidate file grew during read: {path}")
        finish_regular(path, descriptor, before)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def hash_regular(path: Path) -> tuple[int, str]:
    descriptor, before = open_regular(path)
    digest = hashlib.sha256()
    try:
        remaining = before.st_size
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                die(f"candidate file ended early: {path}")
            digest.update(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            die(f"candidate file grew during read: {path}")
        finish_regular(path, descriptor, before)
        return before.st_size, digest.hexdigest()
    finally:
        os.close(descriptor)


def copy_regular(source: Path, destination: Path) -> tuple[int, str]:
    input_fd, before = open_regular(source)
    output_fd = -1
    digest = hashlib.sha256()
    try:
        output_fd = os.open(
            destination,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            0o600,
        )
        remaining = before.st_size
        while remaining:
            chunk = os.read(input_fd, min(1024 * 1024, remaining))
            if not chunk:
                die(f"candidate file ended early: {source}")
            digest.update(chunk)
            view = memoryview(chunk)
            while view:
                view = view[os.write(output_fd, view) :]
            remaining -= len(chunk)
        if os.read(input_fd, 1):
            die(f"candidate file grew during read: {source}")
        finish_regular(source, input_fd, before)
        os.fsync(output_fd)
        os.fchmod(output_fd, 0o644)
        return before.st_size, digest.hexdigest()
    finally:
        if output_fd >= 0:
            os.close(output_fd)
        os.close(input_fd)


def write_regular(path: Path, data: bytes) -> None:
    descriptor = os.open(
        path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600
    )
    try:
        view = memoryview(data)
        while view:
            view = view[os.write(descriptor, view) :]
        os.fsync(descriptor)
        os.fchmod(descriptor, 0o644)
    finally:
        os.close(descriptor)


def normalize_member(name: str) -> str:
    while name.startswith("./"):
        name = name[2:]
    return name.rstrip("/")


def archive_members(path: Path) -> dict[str, tarfile.TarInfo]:
    result: dict[str, tarfile.TarInfo] = {}
    try:
        with tarfile.open(path, "r:*") as archive:
            for member in archive:
                name = normalize_member(member.name)
                if not name or name in result:
                    die(f"archive contains an empty or duplicate entry: {path}")
                result[name] = member
    except (OSError, tarfile.TarError) as error:
        raise CandidateError(f"cannot inspect release archive {path}: {error}") from error
    return result


def archive_text(path: Path, member_name: str) -> str:
    try:
        with tarfile.open(path, "r:*") as archive:
            seen: set[str] = set()
            target: tarfile.TarInfo | None = None
            for member in archive:
                name = normalize_member(member.name)
                if not name or name in seen:
                    die(f"archive contains an empty or duplicate entry: {path}")
                seen.add(name)
                if name == member_name:
                    target = member
            if target is None or not target.isfile() or target.size > MAX_CONTROL_BYTES:
                die(f"archive has no safe {member_name}: {path}")
            extracted = archive.extractfile(target)
            if extracted is None:
                die(f"archive cannot read {member_name}: {path}")
            data = extracted.read(MAX_CONTROL_BYTES + 1)
    except (OSError, tarfile.TarError) as error:
        raise CandidateError(f"cannot inspect release archive {path}: {error}") from error
    if len(data) > MAX_CONTROL_BYTES:
        die(f"archive control file is too large: {member_name}")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError as error:
        raise CandidateError(f"archive control file is not UTF-8: {member_name}") from error


def key_value_manifest(text: str, label: str) -> dict[str, str]:
    result: dict[str, str] = {}
    for line in text.splitlines():
        key, separator, value = line.partition("=")
        if not separator or not key or key in result:
            die(f"{label} contains an invalid or duplicate row")
        result[key] = value
    return result


def expected_names(version: str, names: set[str]) -> set[str]:
    expected = {
        f"ghost-{version}.tar.gz",
        f"ghost-runtime-{version}-linux-x86_64.tar.zst",
        f"ghost-runtime-{version}-linux-x86_64.tar.zst.sha256",
        *FIXED_NAMES,
    }
    if SIGNATURE_NAME in names:
        expected.add(SIGNATURE_NAME)
    return expected


def list_candidate(directory: Path) -> set[str]:
    try:
        directory_info = directory.lstat()
    except OSError as error:
        raise CandidateError(f"cannot inspect candidate directory {directory}: {error}") from error
    if not stat.S_ISDIR(directory_info.st_mode):
        die(f"candidate path is not a real directory: {directory}")
    if stat.S_IMODE(directory_info.st_mode) != 0o755:
        die(f"candidate directory is not mode 0755: {directory}")
    names = set(os.listdir(directory))
    for name in names:
        if name in {".", ".."} or "/" in name:
            die("candidate contains an invalid name")
        info = (directory / name).lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
            die(f"candidate contains a symlink or special file: {name}")
        if stat.S_IMODE(info.st_mode) != 0o644:
            die(f"candidate file is not mode 0644: {name}")
    return names


def parse_sums(data: bytes) -> dict[str, str]:
    try:
        lines = data.decode("utf-8").splitlines()
    except UnicodeDecodeError as error:
        raise CandidateError("SHA256SUMS is not UTF-8") from error
    result: dict[str, str] = {}
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9._+-]+)", line)
        if match is None or match.group(2) in result:
            die("SHA256SUMS contains an invalid or duplicate row")
        result[match.group(2)] = match.group(1)
    if list(result) != sorted(result):
        die("SHA256SUMS is not sorted")
    return result


def strict_metadata(data: bytes) -> dict[str, object]:
    def reject_duplicate_keys(rows: list[tuple[str, object]]) -> dict[str, object]:
        result: dict[str, object] = {}
        for key, value in rows:
            if key in result:
                die(f"RELEASE-METADATA.json contains duplicate key: {key}")
            result[key] = value
        return result

    try:
        loaded = json.loads(data, object_pairs_hook=reject_duplicate_keys)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise CandidateError("RELEASE-METADATA.json is not valid UTF-8 JSON") from error
    if not isinstance(loaded, dict):
        die("RELEASE-METADATA.json is not an object")
    return loaded


def validate_archive_identity(
    directory: Path,
    *,
    version: str,
    commit: str,
    epoch: int,
    sums: dict[str, str],
) -> None:
    source_name = f"ghost-{version}.tar.gz"
    source = directory / source_name
    members = archive_members(source)
    if any(
        Path(name).name in {"AGENTS.md", "CLAUDE.md"}
        for name in members
    ):
        die("sanitized source archive contains private instruction files")
    source_manifest = key_value_manifest(
        archive_text(source, f"ghost-{version}/RELEASE-SOURCE.MANIFEST"),
        "release source manifest",
    )
    expected_source = {
        "format": "ghost-release-source/v1",
        "version": version,
        "source_commit": commit,
        "source_date_epoch": str(epoch),
    }
    if source_manifest != expected_source:
        die("release source manifest identity does not match candidate")

    runtime_name = f"ghost-runtime-{version}-linux-x86_64.tar.zst"
    runtime = directory / runtime_name
    runtime_manifest = key_value_manifest(
        archive_text(runtime, f"ghost-runtime-{version}-linux-x86_64/MANIFEST"),
        "runtime manifest",
    )
    required_runtime = {
        "format": "ghost-runtime-source/v3",
        "version": version,
        "os": "linux",
        "arch": "x86_64",
        "source_commit": commit,
        "source_date_epoch": str(epoch),
    }
    if any(runtime_manifest.get(key) != value for key, value in required_runtime.items()):
        die("runtime manifest identity does not match candidate")

    runtime_sum_name = f"{runtime_name}.sha256"
    expected_runtime_sum = f"{sums[runtime_name]}  {runtime_name}\n".encode()
    if read_regular(directory / runtime_sum_name, MAX_CONTROL_BYTES) != expected_runtime_sum:
        die("runtime checksum does not match candidate runtime")


def verify_candidate(args: argparse.Namespace, *, quiet: bool = False) -> None:
    version = validate_version(args.version)
    repository = validate_repository(
        os.environ.get("GHOST_RELEASE_REPOSITORY", ""),
        "GHOST_RELEASE_REPOSITORY",
    )
    if args.source_tag != f"v{version}":
        die(f"source tag {args.source_tag} does not match version {version}")
    if COMMIT.fullmatch(args.source_commit) is None:
        die("source commit must be a 40-character lowercase SHA")
    epoch = positive_decimal(args.source_date_epoch, "source date epoch")
    workflow_repository = validate_repository(
        args.workflow_repository, "workflow repository"
    )
    workflow_ref = validate_text(args.workflow_ref, "workflow ref")
    run_id = positive_decimal(args.run_id, "run id")
    run_attempt = positive_decimal(args.run_attempt, "run attempt")

    directory = Path(args.candidate)
    names = list_candidate(directory)
    expected = expected_names(version, names)
    if names != expected:
        die(f"candidate inventory mismatch: expected {sorted(expected)!r}, got {sorted(names)!r}")

    asset_names = sorted(expected - FIXED_NAMES - {SIGNATURE_NAME})
    facts: list[dict[str, object]] = []
    actual_sums: dict[str, str] = {}
    for name in asset_names:
        size, digest = hash_regular(directory / name)
        facts.append({"name": name, "sha256": digest, "size": size})
        actual_sums[name] = digest

    metadata_path = directory / "RELEASE-METADATA.json"
    metadata_data = read_regular(metadata_path, MAX_CONTROL_BYTES)
    metadata = strict_metadata(metadata_data)
    if metadata_data != (json.dumps(metadata, indent=2, sort_keys=True) + "\n").encode():
        die("RELEASE-METADATA.json is not canonically serialized")
    required_metadata = {
        "format": FORMAT,
        "release": {
            "repository": repository,
            "tag": args.source_tag,
            "version": version,
        },
        "source": {"commit": args.source_commit, "date_epoch": epoch},
        "provenance": {
            "workflow": {
                "repository": workflow_repository,
                "ref": workflow_ref,
                "run_id": run_id,
                "run_attempt": run_attempt,
            }
        },
        "artifacts": facts,
    }
    if set(metadata) != {"format", "release", "source", "provenance", "artifacts"}:
        die("RELEASE-METADATA.json has an unexpected schema")
    for key in ("format", "release", "source", "artifacts"):
        if metadata.get(key) != required_metadata[key]:
            die(f"RELEASE-METADATA.json {key} does not match candidate")
    provenance = metadata.get("provenance")
    if not isinstance(provenance, dict) or set(provenance) != {
        "workflow",
        "build_tools",
        "actions",
        "containers",
    }:
        die("RELEASE-METADATA.json provenance has an unexpected schema")
    if provenance.get("workflow") != required_metadata["provenance"]["workflow"]:  # type: ignore[index]
        die("RELEASE-METADATA.json workflow does not match source run")
    build_tools = provenance.get("build_tools")
    if (
        not isinstance(build_tools, dict)
        or set(build_tools) != REQUIRED_BUILD_TOOLS
        or any(not isinstance(value, str) or not value for value in build_tools.values())
    ):
        die("RELEASE-METADATA.json build tool versions are incomplete")
    for label in ("actions", "containers"):
        rows = provenance.get(label)
        if not isinstance(rows, dict) or any(
            not isinstance(key, str) or not isinstance(value, str) or not value
            for key, value in rows.items()
        ):
            die(f"RELEASE-METADATA.json {label} metadata is invalid")
    actions = provenance["actions"]
    assert isinstance(actions, dict)
    if any(
        REPOSITORY.fullmatch(key) is None or COMMIT.fullmatch(value) is None
        for key, value in actions.items()
    ):
        die("RELEASE-METADATA.json action metadata is invalid")
    containers = provenance["containers"]
    assert isinstance(containers, dict)
    if any(PAIR_NAME.fullmatch(key) is None for key in containers):
        die("RELEASE-METADATA.json container metadata is invalid")

    _, metadata_sha = hash_regular(metadata_path)
    actual_sums["RELEASE-METADATA.json"] = metadata_sha
    sums_data = read_regular(directory / "SHA256SUMS", MAX_CONTROL_BYTES)
    sums = parse_sums(sums_data)
    canonical_sums = "".join(
        f"{digest}  {name}\n" for name, digest in sums.items()
    ).encode()
    if sums_data != canonical_sums:
        die("SHA256SUMS is not canonically serialized")
    if sums != dict(sorted(actual_sums.items())):
        die("SHA256SUMS does not cover the exact stable public inventory")
    signature_fact: tuple[int, str] | None = None
    if SIGNATURE_NAME in names:
        signature_fact = hash_regular(directory / SIGNATURE_NAME)
        if signature_fact[0] == 0:
            die("detached SHA256SUMS signature is empty")

    validate_archive_identity(
        directory,
        version=version,
        commit=args.source_commit,
        epoch=epoch,
        sums=sums,
    )
    if list_candidate(directory) != names:
        die("candidate inventory changed during verification")
    for name, digest in sums.items():
        if hash_regular(directory / name)[1] != digest:
            die(f"candidate file changed during verification: {name}")
    if parse_sums(read_regular(directory / "SHA256SUMS", MAX_CONTROL_BYTES)) != sums:
        die("SHA256SUMS changed during verification")
    if signature_fact is not None and hash_regular(directory / SIGNATURE_NAME) != signature_fact:
        die("detached SHA256SUMS signature changed during verification")
    if not quiet:
        print(f"Verified public release candidate: {directory.resolve()}")


def metadata_bytes(args: argparse.Namespace, facts: list[dict[str, object]]) -> bytes:
    tools = parse_pairs(args.build_tool, "build tool")
    if set(tools) != REQUIRED_BUILD_TOOLS:
        die(
            "build tool inventory must be exactly: "
            + ", ".join(sorted(REQUIRED_BUILD_TOOLS))
        )
    actions = parse_pairs(
        args.action, "action", repository_keys=True, sha_values=True
    )
    containers = parse_pairs(args.container, "container")
    document = {
        "format": FORMAT,
        "release": {
            "repository": os.environ["GHOST_RELEASE_REPOSITORY"],
            "tag": args.source_tag,
            "version": args.version,
        },
        "source": {
            "commit": args.source_commit,
            "date_epoch": int(args.source_date_epoch),
        },
        "provenance": {
            "workflow": {
                "repository": args.workflow_repository,
                "ref": args.workflow_ref,
                "run_id": int(args.run_id),
                "run_attempt": int(args.run_attempt),
            },
            "build_tools": tools,
            "actions": actions,
            "containers": containers,
        },
        "artifacts": facts,
    }
    return (json.dumps(document, indent=2, sort_keys=True) + "\n").encode()


def compare_candidates(staged: Path, output: Path) -> None:
    staged_names = list_candidate(staged)
    output_names = list_candidate(output)
    if output_names != staged_names:
        die("existing candidate has a different inventory")
    for name in sorted(staged_names):
        if hash_regular(staged / name) != hash_regular(output / name):
            die(f"existing candidate has same-name different bytes: {name}")
    if list_candidate(output) != output_names:
        die("existing candidate changed during comparison")


def create_candidate(args: argparse.Namespace) -> None:
    args.candidate = args.output
    version = validate_version(args.version)
    validate_repository(
        os.environ.get("GHOST_RELEASE_REPOSITORY", ""),
        "GHOST_RELEASE_REPOSITORY",
    )
    if args.source_tag != f"v{version}":
        die(f"source tag {args.source_tag} does not match version {version}")
    if COMMIT.fullmatch(args.source_commit) is None:
        die("source commit must be a 40-character lowercase SHA")
    positive_decimal(args.source_date_epoch, "source date epoch")
    validate_repository(args.workflow_repository, "workflow repository")
    validate_text(args.workflow_ref, "workflow ref")
    positive_decimal(args.run_id, "run id")
    positive_decimal(args.run_attempt, "run attempt")

    inputs = {
        f"ghost-{version}.tar.gz": Path(args.source_archive),
        f"ghost-runtime-{version}-linux-x86_64.tar.zst": Path(args.runtime_archive),
        f"ghost-runtime-{version}-linux-x86_64.tar.zst.sha256": Path(
            args.runtime_checksum
        ),
    }
    signature = Path(args.checksum_signature) if args.checksum_signature else None
    source_paths = [*inputs.values(), *([signature] if signature else [])]
    if len({path.resolve(strict=False) for path in source_paths}) != len(source_paths):
        die("candidate source paths contain a duplicate")
    input_identities: set[tuple[int, int]] = set()
    for path in source_paths:
        try:
            info = path.lstat()
        except OSError as error:
            raise CandidateError(f"cannot inspect candidate input {path}: {error}") from error
        file_identity = (info.st_dev, info.st_ino)
        if file_identity in input_identities:
            die("candidate source paths refer to a duplicate file")
        input_identities.add(file_identity)

    output = Path(args.output)
    output_parent = output.parent.resolve(strict=True)
    output = output_parent / output.name
    if not output.name or output.name in {".", ".."}:
        die("invalid candidate output path")
    try:
        output_info = output.lstat()
    except FileNotFoundError:
        output_info = None
    if output_info is not None and not stat.S_ISDIR(output_info.st_mode):
        die("candidate output must be a real directory")
    temporary: Path | None = Path(
        tempfile.mkdtemp(prefix=f".{output.name}.tmp.", dir=output_parent)
    )
    try:
        facts: list[dict[str, object]] = []
        for name, source in sorted(inputs.items()):
            size, digest = copy_regular(source, temporary / name)
            facts.append({"name": name, "sha256": digest, "size": size})
        metadata = metadata_bytes(args, facts)
        write_regular(temporary / "RELEASE-METADATA.json", metadata)
        sums: list[str] = []
        for name in sorted([*inputs, "RELEASE-METADATA.json"]):
            _, digest = hash_regular(temporary / name)
            sums.append(f"{digest}  {name}\n")
        write_regular(temporary / "SHA256SUMS", "".join(sums).encode())
        if signature is not None:
            copy_regular(signature, temporary / SIGNATURE_NAME)
        os.chmod(temporary, 0o755)
        args.candidate = str(temporary)
        verify_candidate(args, quiet=True)

        if output_info is not None:
            compare_candidates(temporary, output)
            print(f"Public release candidate already matches: {output.resolve()}")
        else:
            os.rename(temporary, output)
            temporary = None
            print(f"Created public release candidate: {output.resolve()}")
    finally:
        if temporary is not None and temporary.exists():
            shutil.rmtree(temporary)


def identity_options(parser: argparse.ArgumentParser) -> None:
    parser.add_argument("--version", required=True)
    parser.add_argument("--source-tag", required=True)
    parser.add_argument("--source-commit", required=True)
    parser.add_argument("--source-date-epoch", required=True)
    parser.add_argument("--workflow-repository", required=True)
    parser.add_argument("--workflow-ref", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--run-attempt", required=True)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("create")
    create.add_argument("--output", required=True)
    create.add_argument("--source-archive", required=True)
    create.add_argument("--runtime-archive", required=True)
    create.add_argument("--runtime-checksum", required=True)
    create.add_argument("--checksum-signature")
    create.add_argument("--build-tool", action="append", default=[])
    create.add_argument("--action", action="append", default=[])
    create.add_argument("--container", action="append", default=[])
    identity_options(create)
    verify = commands.add_parser("verify")
    verify.add_argument("--candidate", required=True)
    identity_options(verify)
    return parser.parse_args()


def main() -> int:
    args = parse_arguments()
    if args.command == "create":
        create_candidate(args)
    else:
        verify_candidate(args)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (CandidateError, OSError, ValueError) as error:
        print(f"public release candidate failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
