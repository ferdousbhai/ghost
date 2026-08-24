"""Coordinate input ops: rich click, drag, scroll, and the hover mouse_move.

These drive the vendored Ydotool button/move/scroll primitives (dead code until
now) through a CompositorTransaction, so the assertions are on the injected
event sequence and on the honesty metadata the transaction produces. A fake
ydotool records events and moves a shared cursor the fake hyprctl reads back, so
the transaction's cursor-restore logic runs for real against a coherent pointer.
"""

from __future__ import annotations

import pytest

from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper.bridge import GhostDesktop


class FakeYdotool:
    """Records injected pointer events; moves the shared cursor on move."""

    def __init__(self, cursor: dict) -> None:
        self._cursor = cursor
        self.events: list = []

    def require(self) -> None:
        pass

    def available(self) -> bool:
        return True

    def move_absolute(self, x: float, y: float) -> None:
        self._cursor["pos"] = (float(x), float(y))
        self.events.append(("move", round(float(x), 3), round(float(y), 3)))

    def button_down(self, button: str = "left") -> None:
        self.events.append(("down", button))

    def button_up(self, button: str = "left") -> None:
        self.events.append(("up", button))

    def scroll(self, delta_y: int, delta_x: int = 0) -> None:
        self.events.append(("scroll", int(delta_y), int(delta_x)))

    def click(self, button: str = "left", *, clicks: int = 1) -> None:
        self.events.append(("click", button, int(clicks)))


def _desktop():
    cursor = {"pos": (0.0, 0.0)}
    hyprctl = FakeHyprctl(_clients=[sample_window()])
    # The active window already focused, on the active workspace, so focus_target
    # notes no focus-change/workspace-switch and only the pointer moves.
    hyprctl.cursor_position = lambda: cursor["pos"]  # type: ignore[method-assign]
    ydotool = FakeYdotool(cursor)
    desktop = GhostDesktop(hyprctl=hyprctl, ydotool=ydotool, runner=unlocked_runner)
    return desktop, ydotool, cursor


def test_click_passes_button_and_clicks():
    desktop, ydotool, _ = _desktop()
    result = desktop.click(x=200, y=200, app="0xaaaa", button="right", clicks=2)
    assert ("click", "right", 2) in ydotool.events
    assert result["button"] == "right"
    assert result["clicks"] == 2
    assert result["background_safe"] is False  # a pointer move is visible


def test_scroll_wheels_the_focused_window():
    desktop, ydotool, _ = _desktop()
    result = desktop.scroll(delta_y=-3, x=200, y=200, app="0xaaaa")
    assert ("scroll", -3, 0) in ydotool.events
    # scroll always changes on-screen content, so it is never background_safe
    assert result["background_safe"] is False
    assert "scroll" in result["interference"]


def test_drag_presses_moves_through_waypoints_then_releases():
    desktop, ydotool, _ = _desktop()
    result = desktop.drag(x1=150, y1=150, x2=250, y2=250, app="0xaaaa", steps=4)
    kinds = [e[0] for e in ydotool.events]
    # button goes down once, up once, and up comes after down
    assert kinds.count("down") == 1
    assert kinds.count("up") == 1
    assert kinds.index("down") < kinds.index("up")
    # at least the interpolated waypoints moved between press and release
    down_at = kinds.index("down")
    up_at = kinds.index("up")
    moves_between = [e for e in ydotool.events[down_at:up_at] if e[0] == "move"]
    assert len(moves_between) >= 4
    # the first move lands on the start point and a move reaches the end point
    assert ("move", 150.0, 150.0) in ydotool.events
    assert ("move", 250.0, 250.0) in ydotool.events
    assert result["button"] == "left"


def test_drag_releases_button_even_if_a_move_raises():
    desktop, ydotool, _ = _desktop()

    real_move = ydotool.move_absolute
    calls = {"n": 0}

    def flaky_move(x, y):
        calls["n"] += 1
        if calls["n"] == 3:  # fail partway through the drag
            raise RuntimeError("pointer wedged")
        real_move(x, y)

    ydotool.move_absolute = flaky_move  # type: ignore[method-assign]
    with pytest.raises(Exception):
        desktop.drag(x1=150, y1=150, x2=250, y2=250, app="0xaaaa", steps=4)
    # the button must not be left stuck down
    kinds = [e[0] for e in ydotool.events]
    assert kinds.count("up") == 1


def test_mouse_move_screen_space_leaves_the_pointer_where_it_moved():
    desktop, ydotool, cursor = _desktop()
    result = desktop.mouse_move(x=640, y=360)
    # exactly one move, to the requested point, and NO restore move back to (0,0)
    moves = [e for e in ydotool.events if e[0] == "move"]
    assert moves == [("move", 640.0, 360.0)]
    assert cursor["pos"] == (640.0, 360.0)
    assert result["background_safe"] is False
    assert "pointer-move" in result["interference"]
    assert any("hover" in w for w in result["warnings"])


def test_mouse_move_window_space_focuses_then_hovers():
    desktop, ydotool, cursor = _desktop()
    # window bounds start at (100, 100); a window-space (10, 20) is screen (110, 120)
    desktop.mouse_move(x=10, y=20, app="0xaaaa", coordinate_space="window")
    assert ("move", 110.0, 120.0) in ydotool.events
    # left where it was moved, not restored
    assert cursor["pos"] == (110.0, 120.0)
