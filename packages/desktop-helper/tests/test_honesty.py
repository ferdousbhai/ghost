"""Honesty metadata on every mutating op, and fail-closed session locking."""

from __future__ import annotations

import pytest

from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper.bridge import GhostDesktop
from ghost_desktop_helper.protocol import Server

_HONESTY = {"backend", "background_safe", "interference", "warnings"}


def _desktop(locked=False, clients=None):
    hyprctl = FakeHyprctl(
        locked_value=locked,
        _clients=clients if clients is not None else [sample_window()],
    )
    return GhostDesktop(hyprctl=hyprctl, runner=unlocked_runner), hyprctl


def test_focus_carries_honesty_and_correct_grammar():
    desktop, hyprctl = _desktop()
    # target a *different* window so focus counts as a change
    hyprctl._clients = [sample_window(address="0xaaaa"),
                        sample_window(address="0xbbbb", pid=5)]
    result = desktop.focus(address="0xbbbb")
    assert _HONESTY <= set(result)
    assert result["background_safe"] is False
    assert "focus-change" in result["interference"]
    # the emitted dispatch is the 0.56 Lua grammar, not the broken string form
    assert hyprctl.dispatched[-1] == ['hl.dsp.focus{ window = "address:0xbbbb" }']


def test_workspace_switch_reports_interference():
    desktop, hyprctl = _desktop()
    result = desktop.workspace(id=5)
    assert result["background_safe"] is False
    assert "workspace-switch" in result["interference"]
    assert hyprctl.dispatched[-1] == ["hl.dsp.focus{ workspace = 5 }"]


def test_key_prefers_background_safe_sendshortcut():
    desktop, hyprctl = _desktop()
    result = desktop.key("super+k", app="0xaaaa")
    assert result["backend"] == "hyprland-sendshortcut"
    assert result["background_safe"] is True
    assert result["interference"] == []
    assert hyprctl.dispatched[-1] == [
        'hl.dsp.send_shortcut{ mods = "SUPER", key = "k", window = "address:0xaaaa" }'
    ]


def test_locked_session_refuses_focus():
    desktop, _ = _desktop(locked=True)
    with pytest.raises(Exception) as exc:
        desktop.focus(address="0xaaaa")
    assert "lock" in str(exc.value).casefold() or "refus" in str(exc.value).casefold()


def test_locked_session_refuses_key_via_protocol():
    desktop, _ = _desktop(locked=True)
    resp = Server(desktop_factory=lambda: desktop).handle(
        {"id": 1, "op": "key", "args": {"chord": "super+k", "app": "0xaaaa"}}
    )
    assert resp["ok"] is False
    assert resp["error"]["code"] == "capability"


def test_unknown_lock_state_fails_closed():
    # hyprland can't tell (None) and loginctl also can't -> refuse
    desktop, _ = _desktop(locked=None)

    def blind_runner(argv, **kw):  # loginctl cannot answer either
        from conftest import FakeResult

        return FakeResult(ok=False, stderr="no session")

    desktop._runner = blind_runner
    with pytest.raises(Exception):
        desktop.focus(address="0xaaaa")
