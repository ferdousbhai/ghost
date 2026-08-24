"""Capture-ladder degradation: the headless rung must not sink the whole shot.

The headless-output rung crops with Pillow, an optional extra. On a stock
install its ``from PIL import Image`` raises ``ImportError`` - which is neither a
CapabilityError nor an OmaHarnessError - so the ladder in
``GhostDesktop._headless_fallback`` has to catch it and fall through to the next
rung rather than let it escape and fail the capture.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper.bridge import GhostDesktop
from omaharness.errors import CapabilityError


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


def test_missing_pillow_degrades_headless_rung_instead_of_failing():
    desktop = _desktop(_RaisingHeadless(ImportError("No module named 'PIL'")))
    warnings: list[str] = []
    client = desktop.hyprctl.clients()[0]

    result = desktop._headless_fallback(client, Path("/nonexistent/ghost-x.png"), warnings)

    # The rung yields nothing (so the ladder continues to focused-region) and
    # says why, rather than raising and killing the capture.
    assert result is None
    assert any("pillow" in w.casefold() for w in warnings)


def test_capability_error_in_headless_rung_still_degrades():
    desktop = _desktop(_RaisingHeadless(CapabilityError("no headless output")))
    warnings: list[str] = []
    client = desktop.hyprctl.clients()[0]

    result = desktop._headless_fallback(client, Path("/nonexistent/ghost-x.png"), warnings)

    assert result is None
    assert any("headless-output capture unavailable" in w for w in warnings)
