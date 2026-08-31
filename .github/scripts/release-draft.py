"""Stage and publish one immutable Ghost release candidate."""

from __future__ import annotations

import argparse
import base64
import binascii
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Any

COMMIT = re.compile(r"^[0-9a-f]{40}$")
REPOSITORY = re.compile(
    r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$"
)
VERSION = re.compile(r"^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$")
ASSET_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._+-]*$")
DIGEST = re.compile(r"^[0-9a-f]{64}$")
BINDING_START = "<!-- ghost-release-binding/v1\n"
BINDING_END = "\n-->"
GITHUB_API_VERSION = "2026-03-10"
MAX_GITHUB_ID = "9223372036854775807"
MAX_VERSION_COMPONENT = "65535"
MAX_BINDING_JSON_BYTES = 4096
CANDIDATE_KEYS = {"candidate_ref", "candidate_commit"}
BASE_BINDING_KEYS = {
    "format",
    "candidate_metadata_sha256",
    "candidate_sha256sums_sha256",
    "release_repository",
    "source_repository",
    "source_run_id",
    "source_run_attempt",
    "source_sha",
    "tag",
    "version",
}


class ReleaseError(RuntimeError):
    pass


@dataclass(frozen=True)
class LocalAsset:
    name: str
    path: Path
    size: int
    sha256: str


@dataclass(frozen=True)
class Candidate:
    directory: Path
    assets: dict[str, LocalAsset]
    metadata: dict[str, Any]


def fail(message: str) -> None:
    raise ReleaseError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def regular_file(path: Path, description: str) -> None:
    if path.is_symlink() or not path.is_file():
        fail(f"{description} is not a regular file: {path.name}")


def valid_version(value: str) -> bool:
    if VERSION.fullmatch(value) is None:
        return False
    parts = value.split(".")
    return any(part != "0" for part in parts) and all(
        len(part) < len(MAX_VERSION_COMPONENT)
        or (len(part) == len(MAX_VERSION_COMPONENT) and part <= MAX_VERSION_COMPONENT)
        for part in parts
    )


def canonical_positive_id(value: object) -> bool:
    return (
        isinstance(value, str)
        and value.isascii()
        and value.isdigit()
        and value[0] != "0"
        and (
            len(value) < len(MAX_GITHUB_ID)
            or (len(value) == len(MAX_GITHUB_ID) and value <= MAX_GITHUB_ID)
        )
    )


def load_candidate(directory: Path) -> Candidate:
    try:
        directory = directory.resolve(strict=True)
    except OSError as error:
        fail(f"candidate directory cannot be resolved: {error}")
    if not directory.is_dir():
        fail("candidate path is not a directory")

    sums_path = directory / "SHA256SUMS"
    metadata_path = directory / "RELEASE-METADATA.json"
    regular_file(sums_path, "checksum manifest")
    regular_file(metadata_path, "release metadata")

    expected: dict[str, str] = {}
    try:
        lines = sums_path.read_text(encoding="utf-8").splitlines()
    except (OSError, UnicodeError) as error:
        fail(f"checksum manifest cannot be read safely: {error}")
    if not lines:
        fail("checksum manifest is empty")
    for line in lines:
        match = re.fullmatch(r"([0-9a-f]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)", line)
        if match is None:
            fail("checksum manifest has a malformed line")
        digest, name = match.groups()
        if name in expected:
            fail(f"checksum manifest repeats {name}")
        if name in {"SHA256SUMS", "SHA256SUMS.sig"}:
            fail(f"checksum manifest must not cover {name}")
        expected[name] = digest
    if "RELEASE-METADATA.json" not in expected:
        fail("checksum manifest does not cover RELEASE-METADATA.json")

    allowed = set(expected) | {"SHA256SUMS"}
    signature = directory / "SHA256SUMS.sig"
    if signature.exists() or signature.is_symlink():
        regular_file(signature, "checksum signature")
        allowed.add(signature.name)
    actual = {entry.name for entry in directory.iterdir()}
    if actual != allowed:
        missing = sorted(allowed - actual)
        unexpected = sorted(actual - allowed)
        fail(
            f"candidate inventory differs (missing={missing}, unexpected={unexpected})"
        )

    assets: dict[str, LocalAsset] = {}
    for name in sorted(allowed):
        if ASSET_NAME.fullmatch(name) is None:
            fail(f"candidate asset name is unsafe: {name!r}")
        path = directory / name
        regular_file(path, "candidate asset")
        digest = sha256_file(path)
        if name in expected and digest != expected[name]:
            fail(f"candidate checksum mismatch: {name}")
        assets[name] = LocalAsset(name, path, path.stat().st_size, digest)

    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        fail(f"release metadata cannot be parsed safely: {error}")
    if not isinstance(metadata, dict):
        fail("release metadata is not an object")
    return Candidate(directory, assets, metadata)


def validate_identity(args: argparse.Namespace, candidate: Candidate) -> dict[str, Any]:
    repository = args.repository
    if not repository and args.mode == "verify-local":
        release = candidate.metadata.get("release")
        value = release.get("repository") if isinstance(release, dict) else None
        repository = value if isinstance(value, str) else ""
    if REPOSITORY.fullmatch(repository) is None:
        fail("destination repository must be one literal owner/name")
    if REPOSITORY.fullmatch(args.source_repository) is None:
        fail("source repository must be one literal owner/name")
    if COMMIT.fullmatch(args.source_sha) is None:
        fail("source SHA must be 40 lowercase hexadecimal characters")
    if not valid_version(args.version):
        fail("version must be a nonzero bounded three-part release version")
    if not canonical_positive_id(args.source_run_id):
        fail("source run ID must be a bounded canonical positive decimal integer")

    metadata = candidate.metadata
    if metadata.get("format") != "ghost-release-candidate/v1":
        fail("release metadata format is not ghost-release-candidate/v1")
    expected_release = {
        "repository": repository,
        "tag": f"v{args.version}",
        "version": args.version,
    }
    if metadata.get("release") != expected_release:
        fail("release metadata release identity does not match the requested candidate")
    source = metadata.get("source")
    if not isinstance(source, dict) or source.get("commit") != args.source_sha:
        fail("release metadata source commit does not match")
    provenance = metadata.get("provenance")
    if not isinstance(provenance, dict):
        fail("release metadata workflow provenance is missing")
    workflow = provenance.get("workflow")
    if not isinstance(workflow, dict):
        fail("release metadata workflow provenance is missing")
    if workflow.get("repository") != args.source_repository:
        fail("release metadata workflow repository does not match")
    run_id = workflow.get("run_id")
    if (
        not isinstance(run_id, int)
        or isinstance(run_id, bool)
        or run_id != int(args.source_run_id)
    ):
        fail("release metadata workflow run ID does not match")
    run_attempt = workflow.get("run_attempt")
    if (
        not isinstance(run_attempt, int)
        or isinstance(run_attempt, bool)
        or not 1 <= run_attempt <= 65535
    ):
        fail("release metadata workflow run attempt is invalid")

    return {
        "format": "ghost-release-binding/v1",
        "candidate_metadata_sha256": candidate.assets["RELEASE-METADATA.json"].sha256,
        "candidate_sha256sums_sha256": candidate.assets["SHA256SUMS"].sha256,
        "release_repository": repository,
        "source_repository": args.source_repository,
        "source_run_id": run_id,
        "source_run_attempt": run_attempt,
        "source_sha": args.source_sha,
        "tag": f"v{args.version}",
        "version": args.version,
    }


def release_body(binding: dict[str, Any]) -> str:
    encoded = canonical_json(binding)
    return f"Ghost {binding['tag']}\n\n{BINDING_START}{encoded}{BINDING_END}\n"


def candidate_branch(binding: dict[str, Any], parent_sha: str) -> str:
    return f"release-candidates/{binding['tag']}/{parent_sha}"


def candidate_record(binding: dict[str, Any]) -> bytes:
    return (json.dumps(binding, indent=2, sort_keys=True) + "\n").encode()


def canonical_json(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def unique_object(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            fail(f"release body candidate binding repeats key: {key}")
        result[key] = value
    return result


def bounded_binding_integer(token: str) -> int:
    if re.fullmatch(r"(?:0|[1-9][0-9]{0,18})", token) is None or (
        len(token) == len(MAX_GITHUB_ID) and token > MAX_GITHUB_ID
    ):
        fail("release body candidate binding has an out-of-range integer")
    return int(token)


def reject_binding_number(_token: str) -> None:
    fail("release body candidate binding contains a non-integer number")


def validate_flat_binding_json(encoded: str) -> None:
    try:
        size = len(encoded.encode("utf-8"))
    except UnicodeError as error:
        fail(f"release body candidate binding is not UTF-8: {error}")
    if size > MAX_BINDING_JSON_BYTES:
        fail("release body candidate binding exceeds its byte limit")
    if not encoded.startswith("{") or not encoded.endswith("}"):
        fail("release body candidate binding is not one JSON object")

    depth = 0
    in_string = False
    escaped = False
    for character in encoded:
        if in_string:
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
        elif character == '"':
            in_string = True
        elif character == "{":
            if depth != 0:
                fail("release body candidate binding must be flat")
            depth = 1
        elif character == "}":
            if depth != 1:
                fail("release body candidate binding has invalid object depth")
            depth = 0
        elif character in "[]":
            fail("release body candidate binding must be flat")
    if in_string or escaped or depth != 0:
        fail("release body candidate binding has invalid JSON structure")


def binding_parts(body: object) -> tuple[str, str, str]:
    if not isinstance(body, str) or body.count(BINDING_START) != 1:
        fail("release body has no unique Ghost candidate binding")
    before, remainder = body.split(BINDING_START, 1)
    if BINDING_END not in remainder:
        fail("release body has no complete Ghost candidate binding")
    encoded, after = remainder.split(BINDING_END, 1)
    return before, encoded, after


def binding_from_body(body: object) -> dict[str, Any]:
    _before, encoded, _after = binding_parts(body)
    validate_flat_binding_json(encoded)
    try:
        binding = json.loads(
            encoded,
            object_pairs_hook=unique_object,
            parse_int=bounded_binding_integer,
            parse_float=reject_binding_number,
            parse_constant=reject_binding_number,
        )
    except (UnicodeError, ValueError, RecursionError) as error:
        fail(f"release body candidate binding is invalid JSON: {error}")
    if not isinstance(binding, dict):
        fail("release body candidate binding is not an object")
    if encoded != canonical_json(binding):
        fail("release body candidate binding is not canonical JSON")
    if set(binding) != BASE_BINDING_KEYS | CANDIDATE_KEYS:
        fail("release body candidate binding has the wrong fields")
    string_fields = BASE_BINDING_KEYS - {"source_run_id", "source_run_attempt"}
    if any(not isinstance(binding.get(key), str) for key in string_fields):
        fail("release body candidate binding has a non-string identity field")
    if binding.get("format") != "ghost-release-binding/v1":
        fail("release body candidate binding format is invalid")
    if any(
        DIGEST.fullmatch(binding[key]) is None
        for key in ("candidate_metadata_sha256", "candidate_sha256sums_sha256")
    ):
        fail("release body candidate binding has an invalid digest")
    if any(
        REPOSITORY.fullmatch(binding[key]) is None
        for key in ("release_repository", "source_repository")
    ):
        fail("release body candidate binding has an invalid repository")
    run_id = binding.get("source_run_id")
    if (
        not isinstance(run_id, int)
        or isinstance(run_id, bool)
        or not 1 <= run_id <= int(MAX_GITHUB_ID)
    ):
        fail("release body candidate binding has an invalid source run ID")
    run_attempt = binding.get("source_run_attempt")
    if (
        not isinstance(run_attempt, int)
        or isinstance(run_attempt, bool)
        or not 1 <= run_attempt <= 65535
    ):
        fail("release body candidate binding has an invalid source run attempt")
    if COMMIT.fullmatch(binding["source_sha"]) is None:
        fail("release body candidate binding has an invalid source SHA")
    if not valid_version(binding["version"]):
        fail("release body candidate binding has an invalid version")
    if binding["tag"] != f"v{binding['version']}":
        fail("release body candidate binding tag and version disagree")
    candidate_ref = binding.get("candidate_ref")
    candidate_commit = binding.get("candidate_commit")
    if not isinstance(candidate_ref, str) or not isinstance(candidate_commit, str):
        fail("release body candidate binding has an invalid candidate identity")
    prefix = f"refs/heads/release-candidates/{binding['tag']}/"
    parent_sha = candidate_ref.removeprefix(prefix)
    if not candidate_ref.startswith(prefix) or COMMIT.fullmatch(parent_sha) is None:
        fail("release body candidate binding has an invalid candidate ref")
    if COMMIT.fullmatch(candidate_commit) is None:
        fail("release body candidate binding has an invalid candidate commit")
    return binding


def base_binding(binding: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in binding.items() if key not in CANDIDATE_KEYS}


def replace_binding(body: object, binding: dict[str, Any]) -> str:
    binding_from_body(body)
    before, _old, after = binding_parts(body)
    encoded = canonical_json(binding)
    return f"{before}{BINDING_START}{encoded}{BINDING_END}{after}"


class GitHub:
    def __init__(self) -> None:
        if not os.environ.get("GH_TOKEN"):
            fail("GH_TOKEN is required for a remote release operation")
        self.executable = "gh"
        if os.environ.get("GHOST_RELEASE_TESTING") == "1":
            self.executable = os.environ.get("GHOST_RELEASE_GH", self.executable)

    def run(self, arguments: list[str], *, output: Any = subprocess.PIPE) -> bytes:
        if arguments[:1] == ["api"]:
            arguments = [
                "api",
                "-H",
                f"X-GitHub-Api-Version: {GITHUB_API_VERSION}",
                *arguments[1:],
            ]
        completed = subprocess.run(
            [self.executable, *arguments],
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.PIPE,
            check=False,
        )
        if completed.returncode != 0:
            detail = completed.stderr.decode("utf-8", "replace").strip()
            fail(f"GitHub API command failed: {detail or 'unknown gh failure'}")
        return completed.stdout if isinstance(completed.stdout, bytes) else b""

    def json(self, arguments: list[str]) -> Any:
        raw = self.run(arguments)
        try:
            return json.loads(raw)
        except (UnicodeError, json.JSONDecodeError) as error:
            fail(f"GitHub API returned ambiguous JSON: {error}")

    def pages(self, endpoint: str) -> list[dict[str, Any]]:
        response = self.json(["api", "--paginate", "--slurp", endpoint])
        if not isinstance(response, list) or any(
            not isinstance(page, list) for page in response
        ):
            fail("GitHub API pagination response is ambiguous")
        items: list[dict[str, Any]] = []
        for page in response:
            if any(not isinstance(item, dict) for item in page):
                fail("GitHub API page contains a non-object item")
            items.extend(page)
        return items

    def json_input(self, method: str, endpoint: str, document: object) -> Any:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            prefix="ghost-release-api-",
        ) as source:
            json.dump(document, source, sort_keys=True, separators=(",", ":"))
            source.flush()
            return self.json(
                [
                    "api",
                    "--method",
                    method,
                    "--input",
                    source.name,
                    endpoint,
                ]
            )

    def download_asset(self, repository: str, asset_id: int, destination: Path) -> None:
        with destination.open("wb") as output:
            self.run(
                [
                    "api",
                    "--method",
                    "GET",
                    "-H",
                    "Accept: application/octet-stream",
                    f"repos/{repository}/releases/assets/{asset_id}",
                ],
                output=output,
            )


def integer(value: object, description: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or not 1 <= value <= int(MAX_GITHUB_ID)
    ):
        fail(f"{description} is not a bounded positive integer")
    return value


def preflight_repository(github: GitHub, repository: str) -> None:
    details = github.json(["api", f"repos/{repository}"])
    if not isinstance(details, dict):
        fail("release repository response is not an object")
    expected = {
        "full_name": repository,
        "private": False,
        "visibility": "public",
        "fork": False,
    }
    for key, value in expected.items():
        if details.get(key) != value:
            fail(f"release repository {key} does not match the public destination")

    immutable = github.json(["api", f"repos/{repository}/immutable-releases"])
    if (
        not isinstance(immutable, dict)
        or immutable.get("enabled") is not True
        or not isinstance(immutable.get("enforced_by_owner"), bool)
    ):
        fail("GitHub did not confirm immutable releases for the public repository")


def validate_release(
    release: object,
    binding: dict[str, Any],
    *,
    require_draft: bool | None,
) -> dict[str, Any]:
    if not isinstance(release, dict):
        fail("GitHub release response is not an object")
    release_id = integer(release.get("id"), "release ID")
    if release.get("tag_name") != binding["tag"]:
        fail("release tag does not match the candidate")
    if release.get("name") != f"Ghost {binding['tag']}":
        fail("release name does not match the candidate")
    if release.get("target_commitish") != binding["candidate_commit"]:
        fail("release target commit does not match the protected candidate")
    if release.get("prerelease") is not False:
        fail("candidate release unexpectedly has prerelease state")
    expected_upload_url = (
        f"https://uploads.github.com/repos/{binding['release_repository']}"
        f"/releases/{release_id}/assets{{?name,label}}"
    )
    if release.get("upload_url") != expected_upload_url:
        fail("release upload URL does not match the exact selected release")
    if binding_from_body(release.get("body")) != binding:
        fail("release source binding does not match the candidate")
    if require_draft is True:
        if release.get("draft") is not True or release.get("published_at") is not None:
            fail("refusing a release that is already published")
    elif require_draft is False and (
        release.get("draft") is not False
        or not isinstance(release.get("published_at"), str)
        or release.get("immutable") is not True
    ):
        fail("GitHub did not publish the candidate as an immutable release")
    elif require_draft is None:
        draft = release.get("draft") is True and release.get("published_at") is None
        published_state = release.get("draft") is False and isinstance(
            release.get("published_at"), str
        )
        if published_state and release.get("immutable") is not True:
            fail("published candidate is not an immutable release")
        published = published_state and release.get("immutable") is True
        if not draft and not published:
            fail("release has an ambiguous draft/publication state")
    return release


def object_sha(value: object, description: str) -> str:
    if not isinstance(value, dict) or not isinstance(value.get("sha"), str):
        fail(f"{description} has no object SHA")
    sha = value["sha"]
    if COMMIT.fullmatch(sha) is None:
        fail(f"{description} has an invalid object SHA")
    return sha


def repository_main(github: GitHub, repository: str) -> str:
    details = github.json(["api", f"repos/{repository}"])
    if not isinstance(details, dict) or details.get("default_branch") != "main":
        fail("release repository default branch must be main")
    branch = github.json(["api", f"repos/{repository}/branches/main"])
    if not isinstance(branch, dict) or branch.get("protected") is not True:
        fail("release repository main branch is not protected")
    commit = branch.get("commit")
    return object_sha(commit, "release repository main branch")


def matching_ref(github: GitHub, repository: str, branch: str) -> dict[str, Any] | None:
    encoded = urllib.parse.quote(branch, safe="")
    response = github.json(
        ["api", f"repos/{repository}/git/matching-refs/heads/{encoded}"]
    )
    if not isinstance(response, list) or any(
        not isinstance(item, dict) for item in response
    ):
        fail("GitHub candidate ref response is ambiguous")
    exact = [item for item in response if item.get("ref") == f"refs/heads/{branch}"]
    if len(exact) > 1 or len(response) != len(exact):
        fail("GitHub candidate ref response is ambiguous")
    return exact[0] if exact else None


def matching_tag_sha(github: GitHub, repository: str, tag: str) -> str | None:
    encoded = urllib.parse.quote(tag, safe="")
    response = github.json(
        ["api", f"repos/{repository}/git/matching-refs/tags/{encoded}"]
    )
    if not isinstance(response, list) or any(
        not isinstance(item, dict) for item in response
    ):
        fail("GitHub release tag response is ambiguous")
    exact = [item for item in response if item.get("ref") == f"refs/tags/{tag}"]
    if len(exact) > 1 or len(response) != len(exact):
        fail("GitHub release tag response is ambiguous")
    if not exact:
        return None
    return object_sha(exact[0].get("object"), "release tag")


def protected_candidate_namespace(github: GitHub, repository: str, branch: str) -> None:
    encoded = urllib.parse.quote(branch, safe="")
    response = github.pages(f"repos/{repository}/rules/branches/{encoded}?per_page=100")
    rule_types = {
        rule.get("type") for rule in response if isinstance(rule.get("type"), str)
    }
    update_rules = [rule for rule in response if rule.get("type") == "update"]
    updates_restricted = bool(update_rules) and all(
        rule.get("parameters") == {"update_allows_fetch_and_merge": False}
        for rule in update_rules
    )
    if (
        not {"deletion", "non_fast_forward"}.issubset(rule_types)
        or not updates_restricted
    ):
        fail(f"release candidate namespace is not write-once protected: {branch}")


def release_tag_rules_snapshot(github: GitHub, repository: str) -> str:
    listed = github.pages(
        f"repos/{repository}/rulesets?includes_parents=true&targets=tag&per_page=100"
    )
    if len(listed) != 2:
        fail("release tag protection must have exactly two active rulesets")
    normalized: list[dict[str, Any]] = []
    seen_ids: set[int] = set()
    expected_scope = {
        "ref_name": {"include": ["refs/tags/v*"], "exclude": []},
    }
    expected_rule_sets = {
        frozenset({"creation"}): "creation",
        frozenset({"update", "deletion", "non_fast_forward"}): "immutable",
    }
    seen_kinds: set[str] = set()
    for summary in listed:
        ruleset_id = integer(summary.get("id"), "release tag ruleset ID")
        if ruleset_id in seen_ids:
            fail("release tag ruleset listing repeats an ID")
        seen_ids.add(ruleset_id)
        ruleset = github.json(["api", f"repos/{repository}/rulesets/{ruleset_id}"])
        if not isinstance(ruleset, dict) or ruleset.get("id") != ruleset_id:
            fail("release tag ruleset detail does not match its listed ID")
        identity = {
            "target": "tag",
            "source_type": "Repository",
            "source": repository,
            "enforcement": "active",
        }
        if any(ruleset.get(key) != value for key, value in identity.items()):
            fail("release tag ruleset identity or enforcement is invalid")
        if any(summary.get(key) != value for key, value in identity.items()):
            fail("listed release tag ruleset identity or enforcement is invalid")
        if ruleset.get("conditions") != expected_scope:
            fail("release tag ruleset scope is not exactly refs/tags/v*")
        rules = ruleset.get("rules")
        if not isinstance(rules, list) or any(
            not isinstance(rule, dict) or not isinstance(rule.get("type"), str)
            for rule in rules
        ):
            fail("release tag ruleset has invalid rules")
        rule_types = frozenset(rule["type"] for rule in rules)
        kind = expected_rule_sets.get(rule_types)
        if kind is None or len(rule_types) != len(rules) or kind in seen_kinds:
            fail("release tag rulesets do not have the two exact rule sets")
        seen_kinds.add(kind)
        if kind == "immutable":
            update = next(rule for rule in rules if rule["type"] == "update")
            if update.get("parameters") != {"update_allows_fetch_and_merge": False}:
                fail("release tag update rule permits fetch-and-merge updates")
        normalized.append(
            {
                "id": ruleset_id,
                **identity,
                "conditions": expected_scope,
                "kind": kind,
                "rule_types": sorted(rule_types),
            }
        )
    if seen_kinds != {"creation", "immutable"}:
        fail("release tag protection is missing a required ruleset")
    return canonical_json(sorted(normalized, key=lambda item: item["id"]))


def create_candidate_commit(
    github: GitHub,
    repository: str,
    branch: str,
    main_sha: str,
    binding: dict[str, Any],
) -> str:
    base = github.json(["api", f"repos/{repository}/git/commits/{main_sha}"])
    if not isinstance(base, dict):
        fail("release repository main commit response is invalid")
    tree_sha = object_sha(base.get("tree"), "release repository main tree")
    record = candidate_record(binding).decode("utf-8")
    blob = github.json_input(
        "POST",
        f"repos/{repository}/git/blobs",
        {"content": record, "encoding": "utf-8"},
    )
    blob_sha = object_sha(blob, "candidate release record blob")
    tree = github.json_input(
        "POST",
        f"repos/{repository}/git/trees",
        {
            "base_tree": tree_sha,
            "tree": [
                {
                    "path": f"releases/{binding['tag']}.json",
                    "mode": "100644",
                    "type": "blob",
                    "sha": blob_sha,
                }
            ],
        },
    )
    candidate_tree = object_sha(tree, "candidate release tree")
    commit = github.json_input(
        "POST",
        f"repos/{repository}/git/commits",
        {
            "message": f"Record Ghost {binding['tag']}",
            "tree": candidate_tree,
            "parents": [main_sha],
        },
    )
    candidate_sha = object_sha(commit, "candidate release commit")
    validate_candidate_commit(
        github,
        repository,
        branch,
        candidate_sha,
        binding,
    )
    created = github.json_input(
        "POST",
        f"repos/{repository}/git/refs",
        {"ref": f"refs/heads/{branch}", "sha": candidate_sha},
    )
    if not isinstance(created, dict) or created.get("ref") != f"refs/heads/{branch}":
        fail("GitHub created the wrong candidate ref")
    if object_sha(created.get("object"), "created candidate ref") != candidate_sha:
        fail("GitHub created the candidate ref at the wrong commit")
    reference = matching_ref(github, repository, branch)
    if reference is None or object_sha(reference.get("object"), "candidate ref") != (
        candidate_sha
    ):
        fail("created candidate ref did not retain its validated commit")
    return candidate_sha


def recursive_tree(
    github: GitHub, repository: str, tree_sha: str, description: str
) -> dict[str, dict[str, Any]]:
    response = github.json(
        ["api", f"repos/{repository}/git/trees/{tree_sha}?recursive=1"]
    )
    if (
        not isinstance(response, dict)
        or response.get("truncated") is not False
        or not isinstance(response.get("tree"), list)
    ):
        fail(f"{description} is incomplete or ambiguous")
    entries: dict[str, dict[str, Any]] = {}
    for entry in response["tree"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str):
            fail(f"{description} contains an invalid entry")
        path = entry["path"]
        if path in entries:
            fail(f"{description} repeats a path")
        entries[path] = {
            "mode": entry.get("mode"),
            "type": entry.get("type"),
            "sha": entry.get("sha"),
        }
    return entries


def validate_candidate_commit(
    github: GitHub,
    repository: str,
    branch: str,
    candidate_sha: str,
    binding: dict[str, Any],
) -> str:
    commit = github.json(["api", f"repos/{repository}/git/commits/{candidate_sha}"])
    if not isinstance(commit, dict):
        fail("candidate commit response is invalid")
    parents = commit.get("parents")
    if not isinstance(parents, list) or len(parents) != 1:
        fail("candidate commit must have exactly one validated parent")
    parent_sha = object_sha(parents[0], "candidate commit parent")
    expected_branch = candidate_branch(binding, parent_sha)
    if branch != expected_branch:
        fail("candidate ref does not bind its exact parent commit")
    parent = github.json(["api", f"repos/{repository}/git/commits/{parent_sha}"])
    if not isinstance(parent, dict):
        fail("candidate first-parent response is invalid")
    parent_tree_sha = object_sha(parent.get("tree"), "candidate first-parent tree")
    candidate_tree_sha = object_sha(commit.get("tree"), "candidate commit tree")
    parent_tree = recursive_tree(
        github, repository, parent_tree_sha, "candidate first-parent tree"
    )
    candidate_tree = recursive_tree(
        github, repository, candidate_tree_sha, "candidate commit tree"
    )
    record_path = urllib.parse.quote(f"releases/{binding['tag']}.json", safe="/")
    if record_path in parent_tree:
        fail("candidate release record already exists on its first parent")
    record_parts = record_path.split("/")
    ancestors = {
        "/".join(record_parts[:index]) for index in range(1, len(record_parts))
    }
    for path in set(parent_tree) | set(candidate_tree):
        if path == record_path:
            continue
        parent_entry = parent_tree.get(path)
        candidate_entry = candidate_tree.get(path)
        if path in ancestors:
            if candidate_entry is None or candidate_entry.get("type") != "tree":
                fail("candidate release record ancestor is not a tree")
            if candidate_entry.get("mode") != "040000":
                fail("candidate release record ancestor has the wrong mode")
            if parent_entry is not None and (
                parent_entry.get("type") != "tree"
                or parent_entry.get("mode") != "040000"
            ):
                fail("candidate release record replaces a non-tree ancestor")
        elif parent_entry != candidate_entry:
            fail("candidate commit changes content outside its release record")
    record_entry = candidate_tree.get(record_path)
    if record_entry is None:
        fail("candidate commit has no release record")
    if record_entry.get("mode") != "100644" or record_entry.get("type") != "blob":
        fail("candidate release record is not one regular blob")
    record = github.json(
        [
            "api",
            f"repos/{repository}/contents/{record_path}?ref={candidate_sha}",
        ]
    )
    if not isinstance(record, dict) or record.get("encoding") != "base64":
        fail("candidate release record response is invalid")
    content = record.get("content")
    if not isinstance(content, str):
        fail("candidate release record has no content")
    try:
        decoded = base64.b64decode("".join(content.splitlines()), validate=True)
    except (ValueError, binascii.Error) as error:
        fail(f"candidate release record is not valid base64: {error}")
    if decoded != candidate_record(binding):
        fail("candidate release record does not match the private source binding")
    if record.get("sha") != record_entry.get("sha"):
        fail("candidate release record and tree disagree")
    protected_candidate_namespace(github, repository, branch)
    return parent_sha


def ensure_candidate_commit(
    github: GitHub,
    repository: str,
    binding: dict[str, Any],
) -> dict[str, Any]:
    for _attempt in range(3):
        main_sha = repository_main(github, repository)
        branch = candidate_branch(binding, main_sha)
        protected_candidate_namespace(github, repository, branch)
        reference = matching_ref(github, repository, branch)
        if reference is None:
            if repository_main(github, repository) != main_sha:
                continue
            candidate_sha = create_candidate_commit(
                github, repository, branch, main_sha, binding
            )
        else:
            candidate_sha = object_sha(reference.get("object"), "candidate ref")
        parent_sha = validate_candidate_commit(
            github,
            repository,
            branch,
            candidate_sha,
            binding,
        )
        current_main = repository_main(github, repository)
        if current_main == parent_sha:
            return {
                **binding,
                "candidate_ref": f"refs/heads/{branch}",
                "candidate_commit": candidate_sha,
            }
    fail("release repository main changed repeatedly while staging")


def validate_bound_candidate(
    github: GitHub,
    repository: str,
    binding: dict[str, Any],
    expected_base: dict[str, Any],
    *,
    main_requirement: str | None,
) -> str:
    if base_binding(binding) != expected_base:
        fail("release source binding does not match the requested candidate")
    branch = binding["candidate_ref"].removeprefix("refs/heads/")
    protected_candidate_namespace(github, repository, branch)
    reference = matching_ref(github, repository, branch)
    if reference is None:
        fail("protected candidate ref does not exist")
    candidate_sha = object_sha(reference.get("object"), "candidate ref")
    if candidate_sha != binding["candidate_commit"]:
        fail("protected candidate ref was rebound to another commit")
    parent_sha = validate_candidate_commit(
        github,
        repository,
        branch,
        candidate_sha,
        expected_base,
    )
    if main_requirement is not None:
        main_sha = repository_main(github, repository)
        acceptable = {
            "parent": {parent_sha},
            "candidate": {candidate_sha},
            "related": {parent_sha, candidate_sha},
        }.get(main_requirement)
        if acceptable is None:
            fail("release orchestration has an invalid main-state requirement")
        if main_sha not in acceptable:
            fail("candidate commit is not a fast-forward of current main")
    return parent_sha


def releases_for_tag(github: GitHub, repository: str, tag: str) -> list[dict[str, Any]]:
    releases = github.pages(f"repos/{repository}/releases?per_page=100")
    ids: set[int] = set()
    for release in releases:
        release_id = integer(release.get("id"), "listed release ID")
        if release_id in ids:
            fail("GitHub release listing contains duplicate IDs")
        ids.add(release_id)
    matches = [release for release in releases if release.get("tag_name") == tag]
    if len(matches) > 1:
        fail("GitHub release listing is ambiguous for the candidate tag")
    return matches


def current_release_for_tag(
    github: GitHub,
    repository: str,
    tag: str,
) -> dict[str, Any] | None:
    matches = releases_for_tag(github, repository, tag)
    if not matches:
        return None
    release_id = integer(matches[0].get("id"), "listed release ID")
    release = github.json(["api", f"repos/{repository}/releases/{release_id}"])
    if not isinstance(release, dict) or release.get("id") != release_id:
        fail("current release response does not match its listed ID")
    return release


def inspect_existing_draft(
    github: GitHub,
    repository: str,
    expected_base: dict[str, Any],
    candidate: Candidate,
) -> tuple[dict[str, Any], dict[str, Any], set[str]] | None:
    release = current_release_for_tag(github, repository, expected_base["tag"])
    if release is None:
        return None
    binding = binding_from_body(release.get("body"))
    validate_release(release, binding, require_draft=True)
    validate_bound_candidate(
        github,
        repository,
        binding,
        expected_base,
        main_requirement=None,
    )
    release_id = integer(release.get("id"), "release ID")
    assets = verify_remote_assets(github, repository, release_id, candidate)
    return release, binding, assets


def update_or_create_draft(
    github: GitHub,
    repository: str,
    binding: dict[str, Any],
    existing: tuple[dict[str, Any], dict[str, Any], set[str]] | None,
) -> dict[str, Any]:
    if existing is not None:
        release, old_binding, _assets = existing
        if old_binding != binding:
            release_id = integer(release.get("id"), "release ID")
            body = replace_binding(release.get("body"), binding)
            release = github.json(
                [
                    "api",
                    "--method",
                    "PATCH",
                    f"repos/{repository}/releases/{release_id}",
                    "-f",
                    f"target_commitish={binding['candidate_commit']}",
                    "-f",
                    f"body={body}",
                ]
            )
        return validate_release(release, binding, require_draft=True)

    created = github.json(
        [
            "api",
            "--method",
            "POST",
            f"repos/{repository}/releases",
            "-f",
            f"tag_name={binding['tag']}",
            "-f",
            f"name=Ghost {binding['tag']}",
            "-f",
            f"target_commitish={binding['candidate_commit']}",
            "-f",
            f"body={release_body(binding)}",
            "-F",
            "draft=true",
            "-F",
            "prerelease=false",
        ]
    )
    return validate_release(created, binding, require_draft=True)


def remote_assets(
    github: GitHub, repository: str, release_id: int
) -> dict[str, dict[str, Any]]:
    listed = github.pages(
        f"repos/{repository}/releases/{release_id}/assets?per_page=100"
    )
    assets: dict[str, dict[str, Any]] = {}
    ids: set[int] = set()
    for asset in listed:
        name = asset.get("name")
        if not isinstance(name, str) or ASSET_NAME.fullmatch(name) is None:
            fail("release contains an asset with an unsafe name")
        asset_id = integer(asset.get("id"), "release asset ID")
        if name in assets or asset_id in ids:
            fail("release asset listing is ambiguous")
        assets[name] = asset
        ids.add(asset_id)
    return assets


def verify_remote_assets(
    github: GitHub,
    repository: str,
    release_id: int,
    candidate: Candidate,
) -> set[str]:
    remote = remote_assets(github, repository, release_id)
    expected_names = set(candidate.assets)
    if not set(remote).issubset(expected_names):
        fail(
            f"draft contains unexpected assets: {sorted(set(remote) - expected_names)}"
        )
    with tempfile.TemporaryDirectory(prefix="ghost-release-assets-") as temporary:
        root = Path(temporary)
        for name, asset in sorted(remote.items()):
            expected = candidate.assets[name]
            if asset.get("size") != expected.size:
                fail(f"draft asset size mismatch: {name}")
            digest = asset.get("digest")
            if digest is not None and digest != f"sha256:{expected.sha256}":
                fail(f"draft asset API digest mismatch: {name}")
            downloaded = root / name
            github.download_asset(
                repository, integer(asset.get("id"), "release asset ID"), downloaded
            )
            if (
                downloaded.stat().st_size != expected.size
                or sha256_file(downloaded) != expected.sha256
            ):
                fail(f"draft asset content mismatch: {name}")
    return set(remote)


def upload_missing(
    github: GitHub,
    repository: str,
    candidate: Candidate,
    existing: set[str],
    release: dict[str, Any],
) -> None:
    release_id = integer(release.get("id"), "release ID")
    expected_upload_url = (
        f"https://uploads.github.com/repos/{repository}/releases/{release_id}"
        "/assets{?name,label}"
    )
    if release.get("upload_url") != expected_upload_url:
        fail("release upload URL does not match the exact selected release")
    upload_url = expected_upload_url.removesuffix("{?name,label}")
    for name in sorted(set(candidate.assets) - existing):
        asset = candidate.assets[name]
        github.run(
            [
                "api",
                "--method",
                "POST",
                "-H",
                "Content-Type: application/octet-stream",
                "--input",
                str(asset.path),
                f"{upload_url}?{urllib.parse.urlencode({'name': name})}",
            ]
        )


def inspect_publication_state(
    github: GitHub,
    repository: str,
    release_id: int,
    expected_base: dict[str, Any],
    accepted_candidate_commit: str,
    candidate: Candidate,
    *,
    require_draft: bool | None,
    require_tag: bool,
    main_requirement: str,
) -> tuple[dict[str, Any], dict[str, Any]]:
    release = current_release_for_tag(github, repository, expected_base["tag"])
    if release is None or integer(release.get("id"), "release ID") != release_id:
        fail("candidate tag no longer identifies the exact staged release")
    binding = binding_from_body(release.get("body"))
    if binding["candidate_commit"] != accepted_candidate_commit:
        fail("owner-accepted candidate commit does not match the staged draft")
    validate_release(
        release,
        binding,
        require_draft=require_draft,
    )
    validate_bound_candidate(
        github,
        repository,
        binding,
        expected_base,
        main_requirement=main_requirement,
    )
    complete = verify_remote_assets(github, repository, release_id, candidate)
    if complete != set(candidate.assets):
        fail(f"draft is missing assets: {sorted(set(candidate.assets) - complete)}")
    tag_sha = matching_tag_sha(github, repository, binding["tag"])
    if tag_sha is not None and tag_sha != binding["candidate_commit"]:
        fail("release tag does not resolve to the candidate commit")
    if (require_tag or release.get("draft") is False) and tag_sha is None:
        fail("published release has no unique exact tag ref")
    return release, binding


def fast_forward_main(
    github: GitHub,
    repository: str,
    binding: dict[str, Any],
) -> None:
    main_sha = repository_main(github, repository)
    candidate_sha = binding["candidate_commit"]
    if main_sha == candidate_sha:
        return
    commit = github.json(["api", f"repos/{repository}/git/commits/{candidate_sha}"])
    if not isinstance(commit, dict):
        fail("candidate commit response is invalid before main update")
    parents = commit.get("parents")
    if not isinstance(parents, list) or len(parents) != 1:
        fail("candidate commit must have exactly one validated parent")
    parent_sha = object_sha(parents[0], "candidate commit parent")
    if main_sha != parent_sha:
        fail("refusing a non-fast-forward release repository update")
    try:
        updated = github.json_input(
            "PATCH",
            f"repos/{repository}/git/refs/heads/main",
            {"sha": candidate_sha, "force": False},
        )
    except ReleaseError:
        if repository_main(github, repository) == candidate_sha:
            return
        raise
    if not isinstance(updated, dict) or updated.get("ref") != "refs/heads/main":
        fail("GitHub returned the wrong updated main ref")
    if object_sha(updated.get("object"), "updated main ref") != candidate_sha:
        fail("GitHub did not advance main to the candidate commit")
    if repository_main(github, repository) != candidate_sha:
        fail("release repository main did not retain the candidate commit")


def append_outputs(path: str | None, values: dict[str, object]) -> None:
    if path is None:
        return
    rows: list[tuple[str, str]] = []
    for key, value in values.items():
        rendered = str(value)
        if "\n" in rendered or "\r" in rendered:
            fail("workflow output contains a newline")
        rows.append((key, rendered))
    output = Path(path)
    with output.open("a", encoding="utf-8") as target:
        for key, rendered in rows:
            target.write(f"{key}={rendered}\n")


def stage(
    args: argparse.Namespace, candidate: Candidate, binding: dict[str, Any]
) -> None:
    github = GitHub()
    preflight_repository(github, args.repository)
    main_sha = repository_main(github, args.repository)
    protected_candidate_namespace(
        github,
        args.repository,
        candidate_branch(binding, main_sha),
    )
    before = inspect_existing_draft(github, args.repository, binding, candidate)
    if matching_tag_sha(github, args.repository, binding["tag"]) is not None:
        fail("refusing a candidate tag that already exists")
    binding = ensure_candidate_commit(github, args.repository, binding)
    after = inspect_existing_draft(
        github,
        args.repository,
        base_binding(binding),
        candidate,
    )
    if before is not None and (
        after is None or after[0].get("id") != before[0].get("id")
    ):
        fail("existing draft changed identity while staging")
    if matching_tag_sha(github, args.repository, binding["tag"]) is not None:
        fail("candidate tag appeared while staging")
    validate_bound_candidate(
        github,
        args.repository,
        binding,
        base_binding(binding),
        main_requirement="parent",
    )
    release = update_or_create_draft(github, args.repository, binding, after)
    release_id = integer(release.get("id"), "release ID")
    existing = verify_remote_assets(github, args.repository, release_id, candidate)
    upload_missing(
        github,
        args.repository,
        candidate,
        existing,
        release,
    )
    final = inspect_existing_draft(
        github,
        args.repository,
        base_binding(binding),
        candidate,
    )
    if (
        final is None
        or integer(final[0].get("id"), "release ID") != release_id
        or final[1] != binding
    ):
        fail("staged draft changed identity after asset upload")
    release, _final_binding, complete = final
    if complete != set(candidate.assets):
        fail(f"draft is missing assets: {sorted(set(candidate.assets) - complete)}")
    if matching_tag_sha(github, args.repository, binding["tag"]) is not None:
        fail("candidate tag appeared during staging")
    validate_bound_candidate(
        github,
        args.repository,
        binding,
        base_binding(binding),
        main_requirement="parent",
    )
    append_outputs(
        args.github_output,
        {
            "candidate_commit": binding["candidate_commit"],
            "candidate_ref": binding["candidate_ref"],
            "release_id": release_id,
            "release_url": release.get("html_url", ""),
        },
    )
    print(f"staged draft release {release_id} with {len(complete)} verified assets")


def anonymous_download(url: str, destination: Path) -> None:
    executable = "curl"
    if os.environ.get("GHOST_RELEASE_TESTING") == "1":
        executable = os.environ.get("GHOST_RELEASE_CURL", executable)
    environment = os.environ.copy()
    for key in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"):
        environment.pop(key, None)
    completed = subprocess.run(
        [
            executable,
            "-q",
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--proto",
            "=https",
            "--tlsv1.2",
            "-H",
            "Authorization:",
            "--output",
            str(destination),
            url,
        ],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env=environment,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.decode("utf-8", "replace").strip()
        fail(f"anonymous release download failed: {detail or 'unknown curl failure'}")


def verify_anonymous(repository: str, tag: str, candidate: Candidate) -> None:
    base = f"https://github.com/{repository}/releases"
    with tempfile.TemporaryDirectory(prefix="ghost-release-public-") as temporary:
        root = Path(temporary)
        last_error: ReleaseError | None = None
        for attempt in range(5):
            try:
                anonymous_download(f"{base}/tag/{tag}", root / "release.html")
                for name, expected in sorted(candidate.assets.items()):
                    downloaded = root / name
                    anonymous_download(
                        f"{base}/download/{tag}/{urllib.parse.quote(name, safe='')}",
                        downloaded,
                    )
                    if (
                        downloaded.stat().st_size != expected.size
                        or sha256_file(downloaded) != expected.sha256
                    ):
                        fail(f"anonymous release asset mismatch: {name}")
                return
            except ReleaseError as error:
                last_error = error
                if attempt < 4:
                    time.sleep(2)
        assert last_error is not None
        raise last_error


def publish(
    args: argparse.Namespace, candidate: Candidate, binding: dict[str, Any]
) -> None:
    github = GitHub()
    preflight_repository(github, args.repository)
    release_id = int(args.release_id)
    release, binding = inspect_publication_state(
        github,
        args.repository,
        release_id,
        binding,
        args.accepted_candidate_commit,
        candidate,
        require_draft=None,
        require_tag=False,
        main_requirement="related",
    )
    parent_sha = binding["candidate_ref"].rsplit("/", 1)[1]
    checkpoint_main = repository_main(github, args.repository)
    pre_main_tag = matching_tag_sha(github, args.repository, binding["tag"])
    if release.get("draft") is True:
        if checkpoint_main == parent_sha and pre_main_tag is not None:
            fail("staged checkpoint has a release tag before main advancement")
    elif checkpoint_main != binding["candidate_commit"]:
        fail("immutable published release is not at the public main checkpoint")
    tag_rules = release_tag_rules_snapshot(github, args.repository)
    fast_forward_main(github, args.repository, binding)
    release, binding = inspect_publication_state(
        github,
        args.repository,
        release_id,
        base_binding(binding),
        args.accepted_candidate_commit,
        candidate,
        require_draft=None,
        require_tag=False,
        main_requirement="candidate",
    )
    checkpoint_tag = matching_tag_sha(github, args.repository, binding["tag"])
    if checkpoint_tag != pre_main_tag:
        fail("release tag appeared or moved during main advancement")
    if release_tag_rules_snapshot(github, args.repository) != tag_rules:
        fail("release tag rulesets changed during publication")
    if matching_tag_sha(github, args.repository, binding["tag"]) != checkpoint_tag:
        fail("release tag changed after its final ruleset validation")
    if release.get("draft") is True:
        try:
            github.json(
                [
                    "api",
                    "--method",
                    "PATCH",
                    f"repos/{args.repository}/releases/{release_id}",
                    "-F",
                    "draft=false",
                ]
            )
        except ReleaseError as publication_error:
            try:
                recovered, binding = inspect_publication_state(
                    github,
                    args.repository,
                    release_id,
                    base_binding(binding),
                    args.accepted_candidate_commit,
                    candidate,
                    require_draft=None,
                    require_tag=False,
                    main_requirement="candidate",
                )
            except ReleaseError as recovery_error:
                fail(
                    "publication failed and its durable checkpoint is invalid: "
                    f"{publication_error}; {recovery_error}"
                )
            if recovered.get("draft") is True:
                raise
    else:
        validate_release(release, binding, require_draft=False)
    inspect_publication_state(
        github,
        args.repository,
        release_id,
        base_binding(binding),
        args.accepted_candidate_commit,
        candidate,
        require_draft=False,
        require_tag=True,
        main_requirement="candidate",
    )
    verify_anonymous(args.repository, binding["tag"], candidate)
    print(f"published and anonymously verified release {release_id}")


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument(
        "mode", choices=("verify-local", "preflight", "stage", "publish")
    )
    result.add_argument("--candidate", type=Path, required=True)
    result.add_argument("--repository", default="")
    result.add_argument("--source-repository", required=True)
    result.add_argument("--source-run-id", required=True)
    result.add_argument("--source-sha", required=True)
    result.add_argument("--version", required=True)
    result.add_argument("--release-id")
    result.add_argument("--accepted-candidate-commit")
    result.add_argument("--github-output")
    return result


def main() -> int:
    args = parser().parse_args()
    try:
        candidate = load_candidate(args.candidate)
        binding = validate_identity(args, candidate)
        if args.mode == "verify-local":
            if (
                args.release_id is not None
                or args.accepted_candidate_commit is not None
                or args.github_output is not None
            ):
                fail("local verification does not accept remote release options")
            print(f"verified local candidate with {len(candidate.assets)} assets")
        elif args.mode == "preflight":
            if (
                args.release_id is not None
                or args.accepted_candidate_commit is not None
                or args.github_output is not None
            ):
                fail("repository preflight does not accept release options")
            github = GitHub()
            preflight_repository(github, args.repository)
            print(f"verified public release repository: {args.repository}")
        elif args.mode == "stage":
            if (
                args.release_id is not None
                or args.accepted_candidate_commit is not None
            ):
                fail(
                    "stage discovers or creates the unique draft; release ID is forbidden"
                )
            stage(args, candidate, binding)
        else:
            if not canonical_positive_id(args.release_id):
                fail("publish requires the exact draft release ID")
            if (
                not isinstance(args.accepted_candidate_commit, str)
                or COMMIT.fullmatch(args.accepted_candidate_commit) is None
            ):
                fail("publish requires the exact owner-accepted candidate commit")
            if args.github_output is not None:
                fail("publish does not produce draft workflow outputs")
            publish(args, candidate, binding)
    except (OSError, ReleaseError) as error:
        print(f"release orchestration failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
