"""The system-PyGObject path bootstrap.

PyGObject ships no wheels, so ``gi`` is whatever the distro compiled for one
minor version. These tests pin the two properties that make importing it from
an isolated environment safe: the version guard (a compiled extension belongs
to exactly one minor version) and appending rather than prepending (nothing the
environment installed may be shadowed by a distro package).
"""

from __future__ import annotations

import sys

import ghost_desktop_helper


def _fake_system_root(tmp_path, tag: str):
    """Build ``<tmp>/usr/lib/<tag>/site-packages/gi`` and return the lib root."""
    root = tmp_path / "usr" / "lib"
    (root / tag / "site-packages" / "gi").mkdir(parents=True)
    return root


def _isolate(monkeypatch, tmp_path, tag: str, *, gi_present: bool = False):
    root = _fake_system_root(tmp_path, tag)
    monkeypatch.setattr(ghost_desktop_helper, "_SYSTEM_LIB_DIRS", (str(root),))
    monkeypatch.setattr(sys, "prefix", str(tmp_path / "venv"))
    monkeypatch.setattr(sys, "base_prefix", str(tmp_path / "base"))
    monkeypatch.setattr(sys, "path", list(sys.path))
    monkeypatch.setattr(
        ghost_desktop_helper._util,
        "find_spec",
        lambda name: object() if gi_present else None,
    )
    monkeypatch.delenv(ghost_desktop_helper.SYSTEM_GI_OPT_OUT, raising=False)
    return root


def _running_tag() -> str:
    return f"python{sys.version_info[0]}.{sys.version_info[1]}"


def test_appends_matching_system_site_packages(monkeypatch, tmp_path):
    root = _isolate(monkeypatch, tmp_path, _running_tag())
    ghost_desktop_helper._bootstrap_system_gi()
    expected = str(root / _running_tag() / "site-packages")
    assert sys.path[-1] == expected, sys.path[-3:]


def test_ignores_a_different_minor_version(monkeypatch, tmp_path):
    """A cp3.9 build cannot be imported by this interpreter; do not add it."""
    _isolate(monkeypatch, tmp_path, "python3.9")
    before = list(sys.path)
    ghost_desktop_helper._bootstrap_system_gi()
    assert sys.path == before


def test_no_op_when_the_environment_already_has_gi(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path, _running_tag(), gi_present=True)
    before = list(sys.path)
    ghost_desktop_helper._bootstrap_system_gi()
    assert sys.path == before


def test_no_op_outside_an_isolated_environment(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path, _running_tag())
    monkeypatch.setattr(sys, "base_prefix", sys.prefix)
    before = list(sys.path)
    ghost_desktop_helper._bootstrap_system_gi()
    assert sys.path == before


def test_opt_out_env_var_is_honoured(monkeypatch, tmp_path):
    _isolate(monkeypatch, tmp_path, _running_tag())
    monkeypatch.setenv(ghost_desktop_helper.SYSTEM_GI_OPT_OUT, "1")
    before = list(sys.path)
    ghost_desktop_helper._bootstrap_system_gi()
    assert sys.path == before
