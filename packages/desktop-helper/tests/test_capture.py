"""Capture-ladder dependency and degradation coverage.

The advertised headless-output rung crops with Pillow, so Pillow is a mandatory
runtime dependency. A damaged or hand-assembled installation may still raise
``ImportError``; the ladder catches that and falls through instead of sinking
the whole capture.
"""

from __future__ import annotations

import tomllib
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper import bridge as bridge_module
from ghost_desktop_helper._vendor.omaharness.errors import (
    CapabilityError,
    OmaHarnessError,
)
from ghost_desktop_helper.bridge import MAX_CAPTURE_BYTES, GhostDesktop


class _RaisingHeadless:
    """A headless backend whose crop step is missing its Pillow dependency."""

    def __init__(self, error: Exception) -> None:
        self._error = error

    def capture(self, client: dict[str, Any], output: Path) -> dict[str, Any]:
        raise self._error


def _desktop(headless: Any) -> GhostDesktop:
    # A hidden window keeps _headless_fallback from short-circuiting on the
    # "already visible on the active workspace" fast path, so it reaches the
    # headless backend where the ImportError is raised.
    hyprctl = FakeHyprctl(_clients=[sample_window(hidden=True, mapped=False)])
    return GhostDesktop(hyprctl=hyprctl, runner=unlocked_runner, headless=headless)


def test_pillow_is_required_for_advertised_headless_rung():
    project = tomllib.loads(
        (Path(__file__).parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    )["project"]

    assert "pillow>=10" in project["dependencies"]
    assert "image" not in project.get("optional-dependencies", {})


def test_damaged_install_missing_pillow_degrades_instead_of_failing():
    desktop = _desktop(_RaisingHeadless(ImportError("No module named 'PIL'")))
    warnings: list[str] = []
    client = desktop.hyprctl.clients()[0]

    result = desktop._headless_fallback(
        client, Path("/nonexistent/ghost-x.png"), warnings
    )

    # The rung yields nothing (so the ladder continues to focused-region) and
    # says why, rather than raising and killing the capture.
    assert result is None
    assert any(
        "pillow" in warning.casefold() and "required runtime dependency" in warning
        for warning in warnings
    )


def test_capability_error_in_headless_rung_still_degrades():
    desktop = _desktop(_RaisingHeadless(CapabilityError("no headless output")))
    warnings: list[str] = []
    client = desktop.hyprctl.clients()[0]

    result = desktop._headless_fallback(
        client, Path("/nonexistent/ghost-x.png"), warnings
    )

    assert result is None
    assert any("headless-output capture unavailable" in w for w in warnings)


def test_oversized_capture_is_rejected_before_read_and_removed(tmp_path: Path):
    path = tmp_path / "oversized.png"
    with path.open("wb") as handle:
        handle.truncate(MAX_CAPTURE_BYTES + 1)

    with pytest.raises(OmaHarnessError, match=r"limited.*8 MiB"):
        GhostDesktop._encode_png({"path": str(path)})

    assert not path.exists()


def test_capture_growth_during_bounded_read_is_rejected(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    path = tmp_path / "growing.png"
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + b"\x00" * 8
        + (1).to_bytes(4, "big")
        + (1).to_bytes(4, "big")
        + b"grew after the first stat"
    )
    real_fstat = bridge_module.os.fstat
    calls = 0

    def staged_fstat(fd: int):
        nonlocal calls
        calls += 1
        actual = real_fstat(fd)
        if calls == 1:
            return SimpleNamespace(st_mode=actual.st_mode, st_size=24)
        return actual

    monkeypatch.setattr(bridge_module.os, "fstat", staged_fstat)
    with pytest.raises(OmaHarnessError, match="changed size while it was being read"):
        GhostDesktop._encode_png({"path": str(path)})

    assert not path.exists()
