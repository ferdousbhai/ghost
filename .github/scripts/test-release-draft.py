"""Black-box fixtures for draft-only staging and explicit publication."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("release-draft.py").resolve()
SOURCE_REPOSITORY = "ferdousbhai/ghost"
RELEASE_REPOSITORY = "ferdousbhai/ghost-releases"
SOURCE_SHA = "1" * 40
RUN_ID = "12345"
VERSION = "0.1.0"


FAKE_CLIENT = r"""#!/usr/bin/env python3
import base64
import hashlib
import json
import os
from pathlib import Path
import sys
from urllib.parse import parse_qs, unquote, urlparse

state_path = Path(os.environ["FAKE_RELEASE_STATE"])
state = json.loads(state_path.read_text(encoding="utf-8"))
repository = os.environ["FAKE_RELEASE_REPOSITORY"]
tag_scope = {"ref_name": {"include": ["refs/tags/v*"], "exclude": []}}
state.setdefault("tag_rulesets", [
    {
        "id": 700,
        "name": "release tag creation",
        "target": "tag",
        "source_type": "Repository",
        "source": repository,
        "enforcement": "active",
        "conditions": tag_scope,
        "rules": [{"type": "creation"}],
    },
    {
        "id": 701,
        "name": "immutable release tags",
        "target": "tag",
        "source_type": "Repository",
        "source": repository,
        "enforcement": "active",
        "conditions": tag_scope,
        "rules": [
            {"type": "update", "parameters": {"update_allows_fetch_and_merge": False}},
            {"type": "deletion"},
            {"type": "non_fast_forward"},
        ],
    },
])
main_sha = state.setdefault("initial_main_sha", "a" * 40)
root_tree = state.setdefault("initial_tree_sha", "b" * 40)
state.setdefault("refs", {"refs/heads/main": main_sha})
state.setdefault("blobs", {})
state.setdefault("trees", {root_tree: {"record": None, "entries": {}}})
state.setdefault("commits", {
    main_sha: {"sha": main_sha, "tree": {"sha": root_tree}, "parents": [], "record": None}
})
arguments = sys.argv[1:]
if arguments[:2] == ["api", "-H"] and len(arguments) >= 4:
    if arguments[2] != "X-GitHub-Api-Version: 2026-03-10":
        raise SystemExit("unexpected GitHub API version")
    arguments = [arguments[0], *arguments[3:]]
state.setdefault("calls", []).append({
    "client": Path(sys.argv[0]).name,
    "argv": arguments,
    "has_token": bool(os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")),
})

def save():
    state_path.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")

def release_json(release):
    return {key: value for key, value in release.items() if key != "assets"}

def asset_json(asset):
    content = base64.b64decode(asset["content"])
    return {
        "id": asset["id"],
        "name": asset["name"],
        "size": len(content),
        "digest": "sha256:" + hashlib.sha256(content).hexdigest(),
    }

def die(message):
    print(message, file=sys.stderr)
    save()
    raise SystemExit(1)

def git_sha(kind, value):
    encoded = json.dumps([kind, value], sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha1(encoded).hexdigest()

if Path(sys.argv[0]).name == "curl":
    if os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN"):
        die("anonymous client inherited a token")
    arguments = sys.argv[1:]
    destination = Path(arguments[arguments.index("--output") + 1])
    url = arguments[-1]
    parsed = urlparse(url)
    parts = parsed.path.strip("/").split("/")
    try:
        release_index = parts.index("releases")
    except ValueError:
        die("unexpected anonymous URL")
    tail = parts[release_index + 1:]
    if tail[:1] == ["tag"] and len(tail) == 2:
        tag = unquote(tail[1])
        matches = [item for item in state["releases"] if item["tag_name"] == tag and not item["draft"]]
        if len(matches) != 1:
            die("published release page unavailable")
        destination.write_bytes(b"release page")
    elif tail[:1] == ["download"] and len(tail) == 3:
        tag, name = map(unquote, tail[1:])
        matches = [item for item in state["releases"] if item["tag_name"] == tag and not item["draft"]]
        if len(matches) != 1:
            die("published release unavailable")
        assets = [item for item in matches[0]["assets"] if item["name"] == name]
        if len(assets) != 1:
            die("published asset unavailable")
        destination.write_bytes(base64.b64decode(assets[0]["content"]))
    else:
        die("unexpected anonymous release path")
    save()
    raise SystemExit(0)

if not os.environ.get("GH_TOKEN"):
    die("gh did not receive its token")

if arguments[:3] == ["api", "--paginate", "--slurp"]:
    endpoint = arguments[3]
    if state.get("ambiguous_pages"):
        print(json.dumps({"not": "pages"}))
    elif "/rules/branches/" in endpoint:
        print(json.dumps([state.get("candidate_rules", [
            {"type": "deletion"},
            {"type": "non_fast_forward"},
            {"type": "update", "parameters": {"update_allows_fetch_and_merge": False}},
        ])]))
    elif "/rulesets?" in endpoint:
        print(json.dumps([[dict(item) for item in state["tag_rulesets"]]]))
    elif endpoint.endswith("/releases?per_page=100"):
        print(json.dumps([[release_json(item) for item in state["releases"]]]))
    elif "/assets?per_page=100" in endpoint:
        release_id = int(endpoint.split("/releases/", 1)[1].split("/", 1)[0])
        release = next(item for item in state["releases"] if item["id"] == release_id)
        print(json.dumps([[asset_json(item) for item in release["assets"]]]))
    else:
        die("unexpected paginated endpoint")
elif arguments[:3] == ["api", "--method", "GET"]:
    endpoint = arguments[-1]
    asset_id = int(endpoint.rsplit("/", 1)[1])
    matches = [
        asset
        for release in state["releases"]
        for asset in release["assets"]
        if asset["id"] == asset_id
    ]
    if len(matches) != 1:
        die("asset not found")
    sys.stdout.buffer.write(base64.b64decode(matches[0]["content"]))
elif arguments[:1] == ["api"] and "--input" in arguments:
    method = arguments[arguments.index("--method") + 1]
    input_path = Path(arguments[arguments.index("--input") + 1])
    endpoint = arguments[-1]
    parsed_endpoint = urlparse(endpoint)
    if method == "POST" and parsed_endpoint.netloc == "uploads.github.com":
        expected_prefix = f"/repos/{os.environ['FAKE_RELEASE_REPOSITORY']}/releases/"
        if not parsed_endpoint.path.startswith(expected_prefix) or not parsed_endpoint.path.endswith("/assets"):
            die("upload URL does not select the release asset endpoint")
        release_id = int(parsed_endpoint.path.removeprefix(expected_prefix).split("/", 1)[0])
        names = parse_qs(parsed_endpoint.query, strict_parsing=True)
        if set(names) != {"name"} or len(names["name"]) != 1:
            die("upload URL has ambiguous asset identity")
        name = names["name"][0]
        if "Content-Type: application/octet-stream" not in arguments:
            die("asset upload has the wrong content type")
        release = next(item for item in state["releases"] if item["id"] == release_id)
        if state.pop("inject_same_tag_before_upload", False):
            injected_id = state["next_release_id"]
            state["next_release_id"] += 1
            state["releases"].append({
                **release_json(release),
                "id": injected_id,
                "upload_url": (
                    f"https://uploads.github.com/repos/{os.environ['FAKE_RELEASE_REPOSITORY']}"
                    f"/releases/{injected_id}/assets{{?name,label}}"
                ),
                "assets": [],
            })
        if (raced_main := state.pop("mutate_main_during_upload", None)) is not None:
            state["refs"]["refs/heads/main"] = raced_main
        if (raced_tag := state.pop("mutate_tag_during_upload", None)) is not None:
            state["refs"][f"refs/tags/{release['tag_name']}"] = raced_tag
        if any(item["name"] == name for item in release["assets"]):
            die("asset already exists (no clobber allowed)")
        asset = {
            "id": state["next_asset_id"],
            "name": name,
            "content": base64.b64encode(input_path.read_bytes()).decode("ascii"),
        }
        state["next_asset_id"] += 1
        release["assets"].append(asset)
        print(json.dumps(asset_json(asset)))
    else:
        document = json.loads(input_path.read_text(encoding="utf-8"))
    if method == "POST" and endpoint.endswith("/git/blobs"):
        sha = git_sha("blob", document)
        state["blobs"][sha] = document["content"]
        print(json.dumps({"sha": sha}))
    elif method == "POST" and endpoint.endswith("/git/trees"):
        sha = git_sha("tree", document)
        entry = document["tree"][0]
        entries = dict(state["trees"][document["base_tree"]]["entries"])
        entries[entry["path"]] = {
            "path": entry["path"],
            "mode": entry["mode"],
            "type": entry["type"],
            "sha": entry["sha"],
        }
        parts = entry["path"].split("/")
        for index in range(1, len(parts)):
            ancestor = "/".join(parts[:index])
            entries[ancestor] = {
                "path": ancestor,
                "mode": "040000",
                "type": "tree",
                "sha": git_sha("ancestor", [document, ancestor]),
            }
        state["trees"][sha] = {
            "record": state["blobs"][entry["sha"]],
            "path": entry["path"],
            "entries": entries,
        }
        print(json.dumps({"sha": sha}))
    elif method == "POST" and endpoint.endswith("/git/commits"):
        sha = git_sha("commit", document)
        state["commits"][sha] = {
            "sha": sha,
            "tree": {"sha": document["tree"]},
            "parents": [{"sha": parent} for parent in document["parents"]],
            "record": state["trees"][document["tree"]]["record"],
        }
        if state.pop("corrupt_candidate_before_ref", False):
            state["trees"][document["tree"]]["entries"]["unexpected"] = {
                "path": "unexpected",
                "mode": "100644",
                "type": "blob",
                "sha": "e" * 40,
            }
        if state.pop("empty_tree_before_ref", False):
            state["trees"][document["tree"]]["entries"]["empty"] = {
                "path": "empty",
                "mode": "040000",
                "type": "tree",
                "sha": "f" * 40,
            }
        print(json.dumps(state["commits"][sha]))
    elif method == "POST" and endpoint.endswith("/git/refs"):
        ref = document["ref"]
        if ref in state["refs"]:
            die("ref already exists")
        state["refs"][ref] = document["sha"]
        print(json.dumps({"ref": ref, "object": {"sha": document["sha"]}}))
    elif method == "PATCH" and "/git/refs/heads/" in endpoint:
        if document.get("force") is not False:
            die("ref update tried to force")
        branch = unquote(endpoint.split("/git/refs/heads/", 1)[1])
        ref = f"refs/heads/{branch}"
        if ref == "refs/heads/main" and (
            raced_main := state.pop("race_main_before_update", None)
        ):
            state["refs"][ref] = raced_main
        current = state["refs"][ref]
        commit = state["commits"][document["sha"]]
        if {parent["sha"] for parent in commit["parents"]}.isdisjoint({current}):
            die("ref update is not a fast-forward")
        state["refs"][ref] = document["sha"]
        if ref == "refs/heads/main" and state.pop("advance_main_then_fail_once", False):
            die("injected ambiguous main update response")
        if ref == "refs/heads/main" and state.pop("attempt_tag_after_main", False):
            state["blocked_tag_injections"] = state.get("blocked_tag_injections", 0) + 1
        if ref == "refs/heads/main" and (wrong_tag := state.pop("mutate_tag_after_main", None)):
            state["refs"][f"refs/tags/{state['releases'][0]['tag_name']}"] = wrong_tag
        if ref == "refs/heads/main" and state.pop("mutate_rulesets_after_main", False):
            state["tag_rulesets"][0]["enforcement"] = "evaluate"
        if ref == "refs/heads/main" and state.pop("inject_duplicate_after_main", False):
            duplicate = dict(state["releases"][0])
            duplicate["id"] = state["next_release_id"]
            duplicate["assets"] = []
            state["next_release_id"] += 1
            state["releases"].append(duplicate)
        print(json.dumps({"ref": ref, "object": {"sha": document["sha"]}}))
    elif parsed_endpoint.netloc != "uploads.github.com":
        die("unexpected JSON API endpoint")
elif arguments[:3] == ["api", "--method", "POST"]:
    endpoint = arguments[3]
    if not endpoint.endswith("/releases"):
        die("unexpected POST endpoint")
    fields = {}
    for index, value in enumerate(arguments):
        if value in {"-f", "-F"}:
            key, field = arguments[index + 1].split("=", 1)
            fields[key] = {"true": True, "false": False}.get(field, field)
    release = {
        "id": state["next_release_id"],
        "tag_name": fields["tag_name"],
        "name": fields["name"],
        "target_commitish": fields["target_commitish"],
        "body": fields["body"],
        "draft": fields["draft"],
        "prerelease": fields["prerelease"],
        "immutable": False,
        "published_at": None,
        "html_url": "https://github.com/example/release",
        "upload_url": (
            f"https://uploads.github.com/repos/{os.environ['FAKE_RELEASE_REPOSITORY']}"
            f"/releases/{state['next_release_id']}/assets{{?name,label}}"
        ),
        "assets": [],
    }
    state["next_release_id"] += 1
    state["releases"].append(release)
    print(json.dumps(release_json(release)))
elif arguments[:3] == ["api", "--method", "PATCH"]:
    endpoint = arguments[3]
    release_id = int(endpoint.rsplit("/", 1)[1])
    release = next(item for item in state["releases"] if item["id"] == release_id)
    fields = {}
    for index, value in enumerate(arguments):
        if value in {"-f", "-F"}:
            key, field = arguments[index + 1].split("=", 1)
            fields[key] = {"true": True, "false": False}.get(field, field)
    if fields.get("draft") is False:
        if state.pop("fail_release_patch_once", False):
            die("injected release publication failure")
        tag_ref = f"refs/tags/{release['tag_name']}"
        existing_tag = state["refs"].get(tag_ref)
        if existing_tag is not None and existing_tag != release["target_commitish"]:
            die("release tag points to another commit")
        state["refs"][tag_ref] = release["target_commitish"]
        release["draft"] = False
        release["immutable"] = True
        release["published_at"] = "2026-08-31T00:00:00Z"
        if state.pop("publish_then_fail_once", False):
            die("injected ambiguous publication response")
    else:
        release["target_commitish"] = fields["target_commitish"]
        release["body"] = fields["body"]
    print(json.dumps(release_json(release)))
elif arguments[:1] == ["api"]:
    endpoint = arguments[-1]
    prefix = f"repos/{repository}"
    if endpoint == prefix:
        print(json.dumps(state.get("repository", {
            "full_name": repository,
            "private": False,
            "visibility": "public",
            "fork": False,
            "default_branch": "main",
        })))
    elif endpoint == prefix + "/immutable-releases":
        print(json.dumps(state.get("immutable", {
            "enabled": True,
            "enforced_by_owner": False,
        })))
    elif endpoint.startswith(prefix + "/branches/"):
        branch = unquote(endpoint.split("/branches/", 1)[1])
        ref = f"refs/heads/{branch}"
        if ref not in state["refs"]:
            die("branch not found")
        protected = branch not in state.get("unprotected_branches", [])
        print(json.dumps({"name": branch, "protected": protected, "commit": {"sha": state["refs"][ref]}}))
    elif endpoint.startswith(prefix + "/git/matching-refs/"):
        tail = endpoint.split("/git/matching-refs/", 1)[1]
        namespace, encoded = tail.split("/", 1)
        name = unquote(encoded)
        ref = f"refs/{namespace}/{name}"
        result = [] if ref not in state["refs"] else [{"ref": ref, "object": {"sha": state["refs"][ref]}}]
        if namespace == "tags" and state.get("ambiguous_tag_refs"):
            result.append({"ref": ref + "-other", "object": {"sha": "f" * 40}})
        print(json.dumps(result))
    elif endpoint.startswith(prefix + "/git/commits/"):
        sha = endpoint.rsplit("/", 1)[1]
        if sha not in state["commits"]:
            die("commit not found")
        print(json.dumps(state["commits"][sha]))
    elif endpoint.startswith(prefix + "/rulesets/"):
        ruleset_id = int(endpoint.rsplit("/", 1)[1])
        matches = [item for item in state["tag_rulesets"] if item["id"] == ruleset_id]
        if len(matches) != 1:
            die("ruleset not found")
        print(json.dumps(matches[0]))
    elif endpoint.startswith(prefix + "/git/trees/"):
        sha = endpoint.split("/git/trees/", 1)[1].split("?", 1)[0]
        if sha not in state["trees"]:
            die("tree not found")
        print(json.dumps({
            "sha": sha,
            "truncated": state.get("tree_truncated", False),
            "tree": list(state["trees"][sha]["entries"].values()),
        }))
    elif endpoint.startswith(prefix + "/contents/"):
        query = endpoint.split("?ref=", 1)
        if len(query) != 2 or query[1] not in state["commits"]:
            die("record commit not found")
        commit = state["commits"][query[1]]
        tree = state["trees"][commit["tree"]["sha"]]
        record = tree["record"]
        if record is None:
            die("record not found")
        path = endpoint.split("/contents/", 1)[1].split("?", 1)[0]
        print(json.dumps({
            "encoding": "base64",
            "content": base64.b64encode(record.encode()).decode(),
            "sha": tree["entries"][path]["sha"],
        }))
    elif "/releases/" in endpoint:
        release_id = int(endpoint.rsplit("/", 1)[1])
        matches = [item for item in state["releases"] if item["id"] == release_id]
        if len(matches) != 1:
            die("release not found")
        print(json.dumps(release_json(matches[0])))
    else:
        die("unexpected GET endpoint")
else:
    die("unexpected fake gh invocation: " + repr(arguments))

save()
"""


class ReleaseDraftFixtures(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="ghost-release-fixture-")
        self.root = Path(self.temporary.name)
        self.candidate = self.root / "candidate"
        self.candidate.mkdir()
        self.state_path = self.root / "state.json"
        self.gh = self.root / "gh"
        self.curl = self.root / "curl"
        for executable in (self.gh, self.curl):
            executable.write_text(FAKE_CLIENT, encoding="utf-8")
            executable.chmod(executable.stat().st_mode | stat.S_IXUSR)
        self.make_candidate()
        self.write_state()

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def make_candidate(self) -> None:
        payloads = {
            "ghost-0.1.0.tar.gz": b"sanitized source",
            "RELEASE-METADATA.json": json.dumps(
                {
                    "format": "ghost-release-candidate/v1",
                    "release": {
                        "repository": RELEASE_REPOSITORY,
                        "tag": f"v{VERSION}",
                        "version": VERSION,
                    },
                    "source": {"commit": SOURCE_SHA, "date_epoch": 1700000000},
                    "provenance": {
                        "workflow": {
                            "repository": SOURCE_REPOSITORY,
                            "ref": "refs/heads/master",
                            "run_id": int(RUN_ID),
                            "run_attempt": 1,
                        },
                        "build_tools": {},
                        "actions": {},
                        "containers": {},
                    },
                    "artifacts": [],
                },
                sort_keys=True,
            ).encode(),
        }
        for name, content in payloads.items():
            (self.candidate / name).write_bytes(content)
        sums = "".join(
            f"{hashlib.sha256(content).hexdigest()}  {name}\n"
            for name, content in sorted(payloads.items())
        )
        (self.candidate / "SHA256SUMS").write_text(sums, encoding="utf-8")

    def write_state(self, **updates: object) -> None:
        state: dict[str, object] = {
            "next_release_id": 100,
            "next_asset_id": 1000,
            "releases": [],
            "calls": [],
        }
        state.update(updates)
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

    def state(self) -> dict[str, object]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    @staticmethod
    def release_binding(state: dict[str, object], index: int = 0) -> dict[str, object]:
        body = state["releases"][index]["body"]
        encoded = body.split("<!-- ghost-release-binding/v1\n", 1)[1].split("\n-->", 1)[
            0
        ]
        return json.loads(encoded)

    @classmethod
    def candidate_ref(cls, state: dict[str, object], index: int = 0) -> str:
        return str(cls.release_binding(state, index)["candidate_ref"])

    @staticmethod
    def asset_uploads(state: dict[str, object]) -> list[dict[str, object]]:
        return [
            call
            for call in state["calls"]
            if call["client"] == "gh"
            and call["argv"][:3] == ["api", "--method", "POST"]
            and str(call["argv"][-1]).startswith("https://uploads.github.com/")
        ]

    def invoke(
        self,
        mode: str,
        *,
        release_id: int | str | None = None,
        accepted_candidate_commit: str | None = None,
        source_run_id: str = RUN_ID,
        version: str = VERSION,
        github_output: Path | None = None,
        token: bool = True,
        expect_success: bool = True,
    ) -> subprocess.CompletedProcess[str]:
        command = [
            sys.executable,
            str(SCRIPT),
            mode,
            "--candidate",
            str(self.candidate),
            "--repository",
            RELEASE_REPOSITORY,
            "--source-repository",
            SOURCE_REPOSITORY,
            "--source-run-id",
            source_run_id,
            "--source-sha",
            SOURCE_SHA,
            "--version",
            version,
        ]
        if release_id is not None:
            command.extend(("--release-id", str(release_id)))
        if mode == "publish":
            if accepted_candidate_commit is None:
                state = self.state()
                accepted_candidate_commit = (
                    str(self.release_binding(state)["candidate_commit"])
                    if state["releases"]
                    else SOURCE_SHA
                )
            command.extend(("--accepted-candidate-commit", accepted_candidate_commit))
        if github_output is not None:
            command.extend(("--github-output", str(github_output)))
        environment = os.environ.copy()
        for key in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"):
            environment.pop(key, None)
        environment.update(
            {
                "GHOST_RELEASE_TESTING": "1",
                "GHOST_RELEASE_GH": str(self.gh),
                "GHOST_RELEASE_CURL": str(self.curl),
                "FAKE_RELEASE_STATE": str(self.state_path),
                "FAKE_RELEASE_REPOSITORY": RELEASE_REPOSITORY,
            }
        )
        if token:
            environment["GH_TOKEN"] = "fixture-token"
        completed = subprocess.run(
            command,
            text=True,
            capture_output=True,
            env=environment,
            check=False,
        )
        if expect_success and completed.returncode != 0:
            self.fail(
                f"helper failed:\nstdout={completed.stdout}\nstderr={completed.stderr}"
            )
        if not expect_success and completed.returncode == 0:
            self.fail(f"helper unexpectedly passed:\n{completed.stdout}")
        return completed

    def stage_new(self) -> int:
        output = self.root / "stage-output"
        self.invoke("stage", github_output=output)
        state = self.state()
        releases = state["releases"]
        self.assertEqual(len(releases), 1)
        branch = self.candidate_ref(state)
        self.assertIn(branch, state["refs"])
        candidate_sha = state["refs"][branch]
        release = releases[0]
        self.assertEqual(release["target_commitish"], candidate_sha)
        self.assertIn(f'"candidate_commit":"{candidate_sha}"', release["body"])
        self.assertIn(f'"candidate_ref":"{branch}"', release["body"])
        rows = dict(line.split("=", 1) for line in output.read_text().splitlines())
        self.assertEqual(rows["candidate_commit"], candidate_sha)
        self.assertEqual(rows["candidate_ref"], branch)
        self.assertEqual(rows["release_id"], str(release["id"]))
        return release["id"]

    def test_local_dry_run_never_invokes_gh_or_requires_token(self) -> None:
        self.invoke("verify-local", token=False)
        self.assertEqual(self.state()["calls"], [])

    def test_oversized_numeric_inputs_fail_cleanly_before_remote_calls(self) -> None:
        huge = "9" * 5000
        cases = [
            ("verify-local", {"source_run_id": huge}),
            ("verify-local", {"version": f"{huge}.0.0"}),
            ("publish", {"release_id": huge}),
        ]
        for mode, overrides in cases:
            with self.subTest(mode=mode, input=next(iter(overrides))):
                result = self.invoke(mode, expect_success=False, **overrides)
                self.assertNotIn("Traceback", result.stderr)
                self.assertEqual(self.state()["calls"], [])

    def test_repository_preflight_requires_exact_public_nonfork_and_immutable(
        self,
    ) -> None:
        self.invoke("preflight")
        baseline = {
            "full_name": RELEASE_REPOSITORY,
            "private": False,
            "visibility": "public",
            "fork": False,
            "default_branch": "main",
        }
        for key, value in (
            ("full_name", "someone/else"),
            ("private", True),
            ("visibility", "private"),
            ("fork", True),
        ):
            with self.subTest(key=key):
                repository = dict(baseline)
                repository[key] = value
                self.write_state(repository=repository)
                result = self.invoke("preflight", expect_success=False)
                self.assertIn(key, result.stderr)
                self.assertEqual(self.state()["releases"], [])

        self.write_state(
            repository=baseline,
            immutable={"enabled": False, "enforced_by_owner": False},
        )
        result = self.invoke("stage", expect_success=False)
        self.assertIn("immutable releases", result.stderr)
        self.assertEqual(self.state()["releases"], [])
        self.assertEqual(set(self.state()["refs"]), {"refs/heads/main"})

    def test_stage_resumes_partial_draft_without_clobbering(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        assets = state["releases"][0]["assets"]
        retained = assets[:1]
        state["releases"][0]["assets"] = retained
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        self.invoke("stage")
        resumed = self.state()
        self.assertEqual(resumed["releases"][0]["id"], release_id)
        self.assertTrue(resumed["releases"][0]["draft"])
        upload_calls = self.asset_uploads(resumed)
        self.assertEqual(len(upload_calls), len(assets) - 1)
        self.assertTrue(
            all(
                f"/releases/{release_id}/assets?" in call["argv"][-1]
                for call in upload_calls
            )
        )

    def test_asset_uploads_remain_bound_to_selected_id_during_same_tag_injection(
        self,
    ) -> None:
        self.write_state(inject_same_tag_before_upload=True)
        result = self.invoke("stage", expect_success=False)
        self.assertIn("ambiguous", result.stderr)
        state = self.state()
        self.assertEqual(len(state["releases"]), 2)
        selected, injected = state["releases"]
        self.assertEqual(selected["id"], 100)
        self.assertEqual(
            {asset["name"] for asset in selected["assets"]},
            {path.name for path in self.candidate.iterdir()},
        )
        self.assertEqual(injected["tag_name"], selected["tag_name"])
        self.assertEqual(injected["assets"], [])
        uploads = self.asset_uploads(state)
        self.assertTrue(uploads)
        self.assertTrue(
            all("/releases/100/assets?" in call["argv"][-1] for call in uploads)
        )

    def test_stage_refuses_ambiguous_machine_binding_without_rewriting_notes(
        self,
    ) -> None:
        self.stage_new()
        state = self.state()
        original = state["releases"][0]["body"]
        state["releases"][0]["body"] = (
            f"Operator note\n{original}<!-- ghost-release-binding/v1\n{{}}\n-->\n"
        )
        ambiguous = state["releases"][0]["body"]
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("stage", expect_success=False)
        self.assertIn("unique Ghost candidate binding", result.stderr)
        self.assertEqual(self.state()["releases"][0]["body"], ambiguous)

    def test_stage_refuses_unprotected_main_or_candidate_namespace(self) -> None:
        self.write_state(unprotected_branches=["main"])
        result = self.invoke("stage", expect_success=False)
        self.assertIn("main branch is not protected", result.stderr)
        self.assertEqual(self.state()["releases"], [])

        self.write_state(candidate_rules=[])
        result = self.invoke("stage", expect_success=False)
        self.assertIn("namespace is not write-once protected", result.stderr)
        self.assertEqual(self.state()["releases"], [])
        self.assertEqual(set(self.state()["refs"]), {"refs/heads/main"})

        for update_rule in (
            None,
            {
                "type": "update",
                "parameters": {"update_allows_fetch_and_merge": True},
            },
        ):
            rules = [{"type": "deletion"}, {"type": "non_fast_forward"}]
            if update_rule is not None:
                rules.append(update_rule)
            self.write_state(candidate_rules=rules)
            with self.subTest(update_rule=update_rule):
                result = self.invoke("stage", expect_success=False)
                self.assertIn("namespace is not write-once protected", result.stderr)
                self.assertEqual(self.state()["releases"], [])
                self.assertEqual(set(self.state()["refs"]), {"refs/heads/main"})

        for corruption in ("corrupt_candidate_before_ref", "empty_tree_before_ref"):
            with self.subTest(corruption=corruption):
                self.write_state(**{corruption: True})
                result = self.invoke("stage", expect_success=False)
                self.assertIn("outside its release record", result.stderr)
                self.assertEqual(self.state()["releases"], [])
                self.assertEqual(set(self.state()["refs"]), {"refs/heads/main"})

    def test_stage_final_checkpoint_rejects_tag_and_main_races(self) -> None:
        fixtures = {
            "tag": {"mutate_tag_during_upload": "e" * 40},
            "main": {"mutate_main_during_upload": "d" * 40},
        }
        for name, update in fixtures.items():
            with self.subTest(name=name):
                self.write_state(**update)
                result = self.invoke("stage", expect_success=False)
                self.assertNotIn("staged draft release", result.stdout)
                state = self.state()
                self.assertEqual(len(state["releases"]), 1)
                self.assertTrue(state["releases"][0]["draft"])
                if name == "tag":
                    self.assertIn("tag appeared", result.stderr)
                else:
                    self.assertIn("not a fast-forward", result.stderr)

    def test_publish_refuses_an_ordinarily_updatable_candidate_ref(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        state["candidate_rules"] = [
            {"type": "deletion"},
            {"type": "non_fast_forward"},
        ]
        state["calls"] = []
        unchanged = {
            "refs": json.loads(json.dumps(state["refs"])),
            "releases": json.loads(json.dumps(state["releases"])),
        }
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("namespace is not write-once protected", result.stderr)
        refused = self.state()
        self.assertEqual(refused["refs"], unchanged["refs"])
        self.assertEqual(refused["releases"], unchanged["releases"])
        self.assertNotIn(f"refs/tags/v{VERSION}", refused["refs"])

    def test_publish_requires_exact_active_repository_tag_rulesets(self) -> None:
        release_id = self.stage_new()
        clean = self.state()

        def changed(index: int, key: str, value: object) -> list[dict[str, object]]:
            rulesets = json.loads(json.dumps(clean["tag_rulesets"]))
            rulesets[index][key] = value
            return rulesets

        missing_rule = json.loads(json.dumps(clean["tag_rulesets"]))
        missing_rule[1]["rules"] = missing_rule[1]["rules"][:-1]
        wrong_rule = json.loads(json.dumps(clean["tag_rulesets"]))
        wrong_rule[0]["rules"] = [{"type": "deletion"}]
        permissive_update = json.loads(json.dumps(clean["tag_rulesets"]))
        permissive_update[1]["rules"][0]["parameters"] = {
            "update_allows_fetch_and_merge": True
        }
        fixtures = {
            "absent": [],
            "inactive": changed(0, "enforcement", "disabled"),
            "evaluate": changed(1, "enforcement", "evaluate"),
            "target": changed(0, "target", "branch"),
            "source": changed(1, "source_type", "Organization"),
            "source-name": changed(0, "source", "someone/else"),
            "include": changed(
                0,
                "conditions",
                {"ref_name": {"include": ["refs/tags/*"], "exclude": []}},
            ),
            "exclude": changed(
                1,
                "conditions",
                {
                    "ref_name": {
                        "include": ["refs/tags/v*"],
                        "exclude": ["refs/tags/v0*"],
                    }
                },
            ),
            "missing-rule": missing_rule,
            "wrong-rule": wrong_rule,
            "update-parameters": permissive_update,
        }
        for name, rulesets in fixtures.items():
            with self.subTest(name=name):
                state = json.loads(json.dumps(clean))
                state["tag_rulesets"] = rulesets
                state["calls"] = []
                unchanged = {
                    "refs": json.loads(json.dumps(state["refs"])),
                    "releases": json.loads(json.dumps(state["releases"])),
                }
                self.state_path.write_text(json.dumps(state), encoding="utf-8")
                result = self.invoke(
                    "publish", release_id=release_id, expect_success=False
                )
                self.assertNotEqual(result.stderr, "")
                refused = self.state()
                self.assertEqual(refused["refs"], unchanged["refs"])
                self.assertEqual(refused["releases"], unchanged["releases"])
                self.assertNotIn(f"refs/tags/v{VERSION}", refused["refs"])

    def test_publish_rechecks_tag_rulesets_after_main_advancement(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        state["mutate_rulesets_after_main"] = True
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("ruleset", result.stderr)
        refused = self.state()
        candidate = self.release_binding(refused)["candidate_commit"]
        self.assertEqual(refused["refs"]["refs/heads/main"], candidate)
        self.assertTrue(refused["releases"][0]["draft"])
        self.assertNotIn(f"refs/tags/v{VERSION}", refused["refs"])
        self.assertFalse(
            any(
                call["client"] == "gh"
                and call["argv"][:3] == ["api", "--method", "PATCH"]
                and "/releases/" in call["argv"][3]
                for call in refused["calls"]
            )
        )

    def test_tag_creation_rules_block_an_ordinary_injection(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        state["attempt_tag_after_main"] = True
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        self.invoke("publish", release_id=release_id)
        published = self.state()
        candidate = self.release_binding(published)["candidate_commit"]
        self.assertEqual(published["blocked_tag_injections"], 1)
        self.assertEqual(published["refs"][f"refs/tags/v{VERSION}"], candidate)

    def test_stage_refuses_mismatched_or_unexpected_existing_asset(self) -> None:
        self.stage_new()
        state = self.state()
        clean = json.loads(json.dumps(state))
        state["releases"][0]["assets"][0]["content"] = base64.b64encode(
            b"corrupt"
        ).decode()
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        result = self.invoke("stage", expect_success=False)
        self.assertIn("mismatch", result.stderr)
        self.assertFalse(self.asset_uploads(self.state()))

        clean["releases"][0]["assets"].append(
            {
                "id": 9000,
                "name": "unexpected.txt",
                "content": base64.b64encode(b"x").decode(),
            }
        )
        clean["calls"] = []
        self.state_path.write_text(json.dumps(clean), encoding="utf-8")
        result = self.invoke("stage", expect_success=False)
        self.assertIn("unexpected assets", result.stderr)

        clean["releases"][0]["assets"] = []
        clean["releases"][0]["upload_url"] = (
            "https://uploads.github.com/repos/attacker/repo/releases/1/assets{?name,label}"
        )
        clean["calls"] = []
        self.state_path.write_text(json.dumps(clean), encoding="utf-8")
        result = self.invoke("stage", expect_success=False)
        self.assertIn("upload URL", result.stderr)
        self.assertFalse(self.asset_uploads(self.state()))

    def test_stage_refuses_ambiguous_api_pagination(self) -> None:
        self.write_state(ambiguous_pages=True)
        result = self.invoke("stage", expect_success=False)
        self.assertIn("pagination response is ambiguous", result.stderr)

    def test_publish_rechecks_unique_tag_after_main_update(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        state["inject_duplicate_after_main"] = True
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("ambiguous", result.stderr)
        interrupted = self.state()
        candidate_ref = self.candidate_ref(interrupted)
        self.assertEqual(
            interrupted["refs"]["refs/heads/main"],
            interrupted["refs"][candidate_ref],
        )
        self.assertFalse(
            any(
                call["client"] == "gh"
                and call["argv"][:3] == ["api", "--method", "PATCH"]
                and "/releases/" in call["argv"][3]
                for call in interrupted["calls"]
            )
        )

    def test_stage_refuses_duplicate_tag_and_published_release(self) -> None:
        self.write_state(
            refs={
                "refs/heads/main": "a" * 40,
                f"refs/tags/v{VERSION}": "c" * 40,
            }
        )
        result = self.invoke("stage", expect_success=False)
        self.assertIn("candidate tag that already exists", result.stderr)

        self.write_state()
        self.stage_new()
        state = self.state()
        duplicate = dict(state["releases"][0])
        duplicate["id"] = 999
        duplicate["assets"] = []
        state["releases"].append(duplicate)
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        result = self.invoke("stage", expect_success=False)
        self.assertIn("ambiguous", result.stderr)

        state["releases"] = state["releases"][:1]
        state["releases"][0]["draft"] = False
        state["releases"][0]["published_at"] = "2026-08-31T00:00:00Z"
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        result = self.invoke("stage", expect_success=False)
        self.assertIn("already published", result.stderr)

        state["releases"][0]["draft"] = True
        state["releases"][0]["published_at"] = None
        state["releases"][0]["tag_name"] = "v9.9.9"
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        result = self.invoke(
            "publish",
            release_id=state["releases"][0]["id"],
            expect_success=False,
        )
        self.assertIn("exact staged release", result.stderr)

    def test_stage_and_publish_are_separate_and_publish_reverifies(self) -> None:
        release_id = self.stage_new()
        staged = self.state()
        self.assertTrue(staged["releases"][0]["draft"])
        self.assertFalse(any("PATCH" in call["argv"] for call in staged["calls"]))
        self.assertFalse(any(call["client"] == "curl" for call in staged["calls"]))

        staged["fail_release_patch_once"] = True
        staged["calls"] = []
        self.state_path.write_text(json.dumps(staged), encoding="utf-8")
        first = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("injected release publication failure", first.stderr)
        interrupted = self.state()
        candidate_ref = self.candidate_ref(interrupted)
        self.assertEqual(
            interrupted["refs"]["refs/heads/main"],
            interrupted["refs"][candidate_ref],
        )
        self.assertTrue(interrupted["releases"][0]["draft"])
        tag_ref = f"refs/tags/v{VERSION}"
        self.assertNotIn(tag_ref, interrupted["refs"])
        calls = interrupted["calls"]
        main_update = next(
            index
            for index, call in enumerate(calls)
            if call["client"] == "gh"
            and call["argv"][-1].endswith("/git/refs/heads/main")
        )
        release_patch = next(
            index
            for index, call in enumerate(calls)
            if call["client"] == "gh"
            and call["argv"][:3] == ["api", "--method", "PATCH"]
            and "/releases/" in call["argv"][3]
        )
        self.assertLess(main_update, release_patch)

        interrupted["calls"] = []
        self.state_path.write_text(json.dumps(interrupted), encoding="utf-8")
        self.invoke("publish", release_id=release_id)
        published = self.state()
        self.assertFalse(published["releases"][0]["draft"])
        self.assertEqual(
            published["refs"]["refs/heads/main"],
            published["refs"][candidate_ref],
        )
        self.assertEqual(published["refs"][tag_ref], published["refs"][candidate_ref])
        calls = published["calls"]
        first_mutation = next(
            index
            for index, call in enumerate(calls)
            if call["client"] == "gh"
            and "--method" in call["argv"]
            and call["argv"][call["argv"].index("--method") + 1] in {"POST", "PATCH"}
        )
        downloads = [
            index
            for index, call in enumerate(calls)
            if call["client"] == "gh"
            and "Accept: application/octet-stream" in call["argv"]
        ]
        self.assertTrue(downloads)
        self.assertGreaterEqual(
            sum(index < first_mutation for index in downloads),
            len(list(self.candidate.iterdir())),
        )
        anonymous = [call for call in calls if call["client"] == "curl"]
        self.assertEqual(len(anonymous), len(list(self.candidate.iterdir())) + 1)
        self.assertTrue(all(not call["has_token"] for call in anonymous))
        self.assertFalse(self.asset_uploads(published))
        self.assertFalse(any(call["argv"][-1].endswith("/git/refs") for call in calls))

        invalid_published = json.loads(json.dumps(published))
        invalid_published["refs"]["refs/heads/main"] = candidate_ref.rsplit("/", 1)[1]
        invalid_published["calls"] = []
        immutable_state = {
            "refs": json.loads(json.dumps(invalid_published["refs"])),
            "releases": json.loads(json.dumps(invalid_published["releases"])),
        }
        self.state_path.write_text(json.dumps(invalid_published), encoding="utf-8")
        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("public main checkpoint", result.stderr)
        refused = self.state()
        self.assertEqual(refused["refs"], immutable_state["refs"])
        self.assertEqual(refused["releases"], immutable_state["releases"])

        published["calls"] = []
        self.state_path.write_text(json.dumps(published), encoding="utf-8")
        self.invoke("publish", release_id=release_id)
        retried = self.state()
        self.assertFalse(retried["releases"][0]["draft"])
        self.assertFalse(
            any(
                call["client"] == "gh"
                and call["argv"][:3] == ["api", "--method", "PATCH"]
                and "/releases/" in call["argv"][3]
                for call in retried["calls"]
            )
        )
        retried["releases"][0]["immutable"] = False
        retried["calls"] = []
        self.state_path.write_text(json.dumps(retried), encoding="utf-8")
        result = self.invoke(
            "publish",
            release_id=release_id,
            expect_success=False,
        )
        self.assertIn("immutable release", result.stderr)

    def test_publish_main_race_leaves_no_tag_and_restage_recovers(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        candidate_ref = self.candidate_ref(state)
        old_candidate = state["refs"][candidate_ref]
        divergent = "d" * 40
        state["commits"][divergent] = {
            "sha": divergent,
            "tree": {"sha": state["initial_tree_sha"]},
            "parents": [{"sha": state["initial_main_sha"]}],
            "record": None,
        }
        state["race_main_before_update"] = divergent
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("not a fast-forward", result.stderr)
        raced = self.state()
        self.assertEqual(raced["refs"]["refs/heads/main"], divergent)
        self.assertNotIn(f"refs/tags/v{VERSION}", raced["refs"])
        self.assertTrue(raced["releases"][0]["draft"])

        raced["calls"] = []
        self.state_path.write_text(json.dumps(raced), encoding="utf-8")
        self.invoke("stage")
        corrected = self.state()
        corrected_candidate = self.release_binding(corrected)["candidate_commit"]
        self.assertNotEqual(corrected_candidate, old_candidate)
        self.invoke(
            "publish",
            release_id=release_id,
            accepted_candidate_commit=str(corrected_candidate),
        )
        published = self.state()
        self.assertEqual(published["refs"]["refs/heads/main"], corrected_candidate)
        self.assertEqual(
            published["refs"][f"refs/tags/v{VERSION}"], corrected_candidate
        )

    def test_publish_recovers_ambiguous_successful_responses(self) -> None:
        for flag in ("advance_main_then_fail_once", "publish_then_fail_once"):
            with self.subTest(flag=flag):
                self.write_state()
                release_id = self.stage_new()
                state = self.state()
                state[flag] = True
                state["calls"] = []
                self.state_path.write_text(json.dumps(state), encoding="utf-8")

                self.invoke("publish", release_id=release_id)
                recovered = self.state()
                candidate = self.release_binding(recovered)["candidate_commit"]
                self.assertFalse(recovered["releases"][0]["draft"])
                self.assertEqual(recovered["refs"]["refs/heads/main"], candidate)
                self.assertEqual(recovered["refs"][f"refs/tags/v{VERSION}"], candidate)

    def test_publish_refuses_wrong_or_ambiguous_tag_without_mutation(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        main = state["refs"]["refs/heads/main"]
        state["refs"][f"refs/tags/v{VERSION}"] = "e" * 40
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")
        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("does not resolve", result.stderr)
        wrong = self.state()
        self.assertEqual(wrong["refs"]["refs/heads/main"], main)
        self.assertTrue(wrong["releases"][0]["draft"])
        self.assertFalse(
            any(
                "--method" in call["argv"]
                and call["argv"][call["argv"].index("--method") + 1]
                in {"POST", "PATCH"}
                for call in wrong["calls"]
            )
        )

        wrong["refs"][f"refs/tags/v{VERSION}"] = self.release_binding(wrong)[
            "candidate_commit"
        ]
        wrong["calls"] = []
        self.state_path.write_text(json.dumps(wrong), encoding="utf-8")
        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("tag before main advancement", result.stderr)
        premature = self.state()
        self.assertEqual(premature["refs"]["refs/heads/main"], main)
        self.assertTrue(premature["releases"][0]["draft"])

        del premature["refs"][f"refs/tags/v{VERSION}"]
        premature["ambiguous_tag_refs"] = True
        premature["calls"] = []
        self.state_path.write_text(json.dumps(premature), encoding="utf-8")
        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("ambiguous", result.stderr)
        ambiguous = self.state()
        self.assertEqual(ambiguous["refs"]["refs/heads/main"], main)
        self.assertTrue(ambiguous["releases"][0]["draft"])
        self.assertFalse(
            any(
                "--method" in call["argv"]
                and call["argv"][call["argv"].index("--method") + 1]
                in {"POST", "PATCH"}
                for call in ambiguous["calls"]
            )
        )

    def test_publish_detects_tag_conflict_after_main_advance(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        candidate_ref = self.candidate_ref(state)
        candidate = state["refs"][candidate_ref]
        state["mutate_tag_after_main"] = "e" * 40
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("tag does not resolve", result.stderr)
        conflicted = self.state()
        self.assertEqual(conflicted["refs"]["refs/heads/main"], candidate)
        self.assertEqual(conflicted["refs"][f"refs/tags/v{VERSION}"], "e" * 40)
        self.assertTrue(conflicted["releases"][0]["draft"])

    def test_stage_creates_single_parent_correction_and_invalidates_old_approval(
        self,
    ) -> None:
        release_id = self.stage_new()
        state = self.state()
        candidate_ref = self.candidate_ref(state)
        original_candidate = state["refs"][candidate_ref]
        divergent = "d" * 40
        state["commits"][divergent] = {
            "sha": divergent,
            "tree": {"sha": state["initial_tree_sha"]},
            "parents": [{"sha": state["initial_main_sha"]}],
            "record": None,
        }
        state["refs"]["refs/heads/main"] = divergent
        body = state["releases"][0]["body"]
        state["releases"][0]["body"] = f"Operator intro\n\n{body}\nOperator tail\n"
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("not a fast-forward", result.stderr)
        self.assertEqual(self.state()["refs"]["refs/heads/main"], divergent)

        self.invoke("stage")
        corrected = self.state()
        corrected_ref = self.candidate_ref(corrected)
        corrected_candidate = corrected["refs"][corrected_ref]
        self.assertNotEqual(corrected_ref, candidate_ref)
        self.assertNotEqual(corrected_candidate, original_candidate)
        self.assertEqual(
            [
                parent["sha"]
                for parent in corrected["commits"][corrected_candidate]["parents"]
            ],
            [divergent],
        )
        release = corrected["releases"][0]
        self.assertEqual(release["id"], release_id)
        self.assertTrue(release["draft"])
        self.assertEqual(release["target_commitish"], corrected_candidate)
        self.assertIn(f'"candidate_commit":"{corrected_candidate}"', release["body"])
        self.assertTrue(release["body"].startswith("Operator intro\n\n"))
        self.assertTrue(release["body"].endswith("\nOperator tail\n"))
        ref_updates = [
            call
            for call in corrected["calls"]
            if call["client"] == "gh" and call["argv"][-1].endswith("/git/refs")
        ]
        self.assertEqual(len(ref_updates), 1)

        unchanged = {
            "refs": json.loads(json.dumps(corrected["refs"])),
            "releases": json.loads(json.dumps(corrected["releases"])),
        }
        corrected["calls"] = []
        self.state_path.write_text(json.dumps(corrected), encoding="utf-8")
        stale = self.invoke(
            "publish",
            release_id=release_id,
            accepted_candidate_commit=original_candidate,
            expect_success=False,
        )
        self.assertIn("owner-accepted candidate commit", stale.stderr)
        refused = self.state()
        self.assertEqual(refused["refs"], unchanged["refs"])
        self.assertEqual(refused["releases"], unchanged["releases"])

        refused["calls"] = []
        self.state_path.write_text(json.dumps(refused), encoding="utf-8")
        self.invoke(
            "publish",
            release_id=release_id,
            accepted_candidate_commit=corrected_candidate,
        )
        published = self.state()
        self.assertEqual(published["refs"]["refs/heads/main"], corrected_candidate)

    def test_publish_refuses_candidate_tree_with_any_extra_delta(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        candidate_ref = self.candidate_ref(state)
        candidate = state["refs"][candidate_ref]
        tree_sha = state["commits"][candidate]["tree"]["sha"]
        state["trees"][tree_sha]["entries"]["unexpected"] = {
            "path": "unexpected",
            "mode": "100644",
            "type": "blob",
            "sha": "e" * 40,
        }
        state["calls"] = []
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("outside its release record", result.stderr)
        self.assertNotEqual(self.state()["refs"]["refs/heads/main"], candidate)

    def test_publish_rejects_second_parent_before_any_mutation(self) -> None:
        release_id = self.stage_new()
        state = self.state()
        candidate_ref = self.candidate_ref(state)
        candidate = state["refs"][candidate_ref]
        state["commits"][candidate]["parents"].append({"sha": "e" * 40})
        state["calls"] = []
        unchanged = {
            "refs": json.loads(json.dumps(state["refs"])),
            "releases": json.loads(json.dumps(state["releases"])),
        }
        self.state_path.write_text(json.dumps(state), encoding="utf-8")

        result = self.invoke("publish", release_id=release_id, expect_success=False)
        self.assertIn("exactly one validated parent", result.stderr)
        refused = self.state()
        self.assertEqual(refused["refs"], unchanged["refs"])
        self.assertEqual(refused["releases"], unchanged["releases"])
        self.assertNotIn(f"refs/tags/v{VERSION}", refused["refs"])

    def test_poisoned_binding_duplicate_release_and_rebound_ref_do_not_mutate(
        self,
    ) -> None:
        release_id = self.stage_new()
        clean = self.state()
        accepted = str(self.release_binding(clean)["candidate_commit"])
        body = clean["releases"][0]["body"]
        before, remainder = body.split("<!-- ghost-release-binding/v1\n", 1)
        encoded, after = remainder.split("\n-->", 1)
        binding = json.loads(encoded)
        poisoned_bodies = {
            "duplicate-key": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + encoded[:-1]
                + f',"version":"{VERSION}"}}'
                + "\n-->"
                + after
            ),
            "wrong-type": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + json.dumps(
                    {**binding, "source_run_id": RUN_ID},
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n-->"
                + after
            ),
            "wrong-attempt-type": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + json.dumps(
                    {**binding, "source_run_attempt": "1"},
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n-->"
                + after
            ),
            "noncanonical": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + json.dumps(binding, sort_keys=True)
                + "\n-->"
                + after
            ),
            "oversized": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + '{"padding":"'
                + ("x" * 5000)
                + '"}'
                + "\n-->"
                + after
            ),
            "nested": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + json.dumps(
                    {**binding, "candidate_commit": {"sha": "1" * 40}},
                    sort_keys=True,
                    separators=(",", ":"),
                )
                + "\n-->"
                + after
            ),
            "deep": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + ("[" * 1000)
                + "0"
                + ("]" * 1000)
                + "\n-->"
                + after
            ),
            "oversized-number": (
                before
                + "<!-- ghost-release-binding/v1\n"
                + encoded.replace(
                    f'"source_run_id":{RUN_ID}',
                    '"source_run_id":' + ("9" * 100),
                )
                + "\n-->"
                + after
            ),
        }
        fixtures: dict[str, dict[str, object]] = {}
        for name, poisoned in poisoned_bodies.items():
            state = json.loads(json.dumps(clean))
            state["releases"][0]["body"] = poisoned
            fixtures[name] = state

        duplicate = json.loads(json.dumps(clean))
        duplicate_release = json.loads(json.dumps(duplicate["releases"][0]))
        duplicate_release["id"] = 999
        duplicate_release["assets"] = []
        duplicate["releases"].append(duplicate_release)
        fixtures["duplicate-release"] = duplicate

        rebound = json.loads(json.dumps(clean))
        rebound["refs"][self.candidate_ref(rebound)] = "e" * 40
        fixtures["rebound-ref"] = rebound

        for name, state in fixtures.items():
            for mode in ("stage", "publish"):
                with self.subTest(name=name, mode=mode):
                    current = json.loads(json.dumps(state))
                    current["calls"] = []
                    unchanged = {
                        "refs": json.loads(json.dumps(current["refs"])),
                        "releases": json.loads(json.dumps(current["releases"])),
                    }
                    self.state_path.write_text(json.dumps(current), encoding="utf-8")
                    result = self.invoke(
                        mode,
                        release_id=release_id if mode == "publish" else None,
                        accepted_candidate_commit=(
                            accepted if mode == "publish" else None
                        ),
                        expect_success=False,
                    )
                    self.assertNotEqual(result.stderr, "")
                    self.assertNotIn("Traceback", result.stderr)
                    refused = self.state()
                    self.assertEqual(refused["refs"], unchanged["refs"])
                    self.assertEqual(refused["releases"], unchanged["releases"])
                    self.assertNotIn(f"refs/tags/v{VERSION}", refused["refs"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
