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
from conftest import FakeHyprctl, FakeResult, sample_window, unlocked_runner

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


class _AvailableCaptureRouter:
    @staticmethod
    def capabilities() -> SimpleNamespace:
        return SimpleNamespace(installed=True)


class _PngRunner:
    def __init__(self) -> None:
        self.calls: list[tuple[list[str], float | None]] = []

    def __call__(self, argv: list[str], *, timeout: float | None = None) -> FakeResult:
        self.calls.append((argv, timeout))
        Path(argv[-1]).write_bytes(
            b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR"
            + (1).to_bytes(4, "big")
            + (1).to_bytes(4, "big")
        )
        return FakeResult()


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


def test_output_capture_uses_direct_grim_with_honest_provenance():
    runner = _PngRunner()
    desktop = GhostDesktop(
        hyprctl=FakeHyprctl(),
        capture_router=_AvailableCaptureRouter(),
        runner=runner,
    )

    result = desktop.capture(target="screen", output="eDP-1")

    assert runner.calls[0][0][:-1] == ["grim", "-t", "png", "-o", "eDP-1"]
    assert runner.calls[0][1] == 6.0
    assert result["backend"] == "grim-output"
    assert result["capture_mode"] == "output"
    assert result["background_safe"] is True
    assert result["interference"] == []
    assert result["warnings"] == []
    assert result["output"] == "eDP-1"
    assert not Path(runner.calls[0][0][-1]).exists()


def test_region_capture_uses_direct_grim_and_warns_about_composited_pixels():
    runner = _PngRunner()
    desktop = GhostDesktop(
        hyprctl=FakeHyprctl(),
        capture_router=_AvailableCaptureRouter(),
        runner=runner,
    )
    region = {"x": 10.0, "y": 20.0, "width": 30.0, "height": 40.0}

    result = desktop.capture(target="region", region=region)

    assert runner.calls[0][0][:-1] == [
        "grim",
        "-t",
        "png",
        "-g",
        "10,20 30x40",
    ]
    assert runner.calls[0][1] == 6.0
    assert result["backend"] == "grim-region"
    assert result["capture_mode"] == "region"
    assert result["background_safe"] is True
    assert result["interference"] == []
    assert any("currently-composited pixels" in item for item in result["warnings"])
    assert result["region"] == region
    assert not Path(runner.calls[0][0][-1]).exists()


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
