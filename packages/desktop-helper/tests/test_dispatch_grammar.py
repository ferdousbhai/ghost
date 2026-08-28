"""The dispatch-grammar selection: the whole reason this helper exists.

This machine is Hyprland 0.56.2, where the pre-0.56 string grammar
(``focuswindow address:0x…``) is a Lua *syntax error*. These tests pin the
encoder to emit the right grammar per generation, honour the env override, and
refuse the one silent-wrong-window mistake.
"""

from __future__ import annotations

import pytest

from ghost_desktop_helper._vendor.omaharness import dispatch as dg
from ghost_desktop_helper._vendor.omaharness.errors import CapabilityError


def test_lua_focus_window_uses_named_table():
    enc = dg.DispatchEncoder(dg.LUA)
    assert enc.focus_window("0xdead") == ['hl.dsp.focus{ window = "address:0xdead" }']


def test_legacy_focus_window_uses_string_grammar():
    enc = dg.DispatchEncoder(dg.LEGACY)
    assert enc.focus_window("0xdead") == ["focuswindow", "address:0xdead"]


def test_lua_focus_workspace_named_table():
    enc = dg.DispatchEncoder(dg.LUA)
    assert enc.focus_workspace(3) == ["hl.dsp.focus{ workspace = 3 }"]


def test_legacy_focus_workspace_string():
    enc = dg.DispatchEncoder(dg.LEGACY)
    assert enc.focus_workspace(3) == ["workspace", "3"]


def test_probe_acceptance_selects_lua():
    detected = dg.detect(lambda args: args == [dg.PROBE])
    assert detected["generation"] == dg.LUA
    assert detected["detected_by"] == "probe"


def test_probe_rejection_falls_back_to_legacy():
    detected = dg.detect(lambda args: False)
    assert detected["generation"] == dg.LEGACY


def test_env_override_wins(monkeypatch):
    monkeypatch.setenv(dg.ENV_OVERRIDE, dg.LEGACY)
    detected = dg.detect(lambda args: True)  # probe would say LUA
    assert detected["generation"] == dg.LEGACY
    assert detected["detected_by"] == "environment"


def test_env_override_rejects_garbage(monkeypatch):
    monkeypatch.setenv(dg.ENV_OVERRIDE, "nonsense")
    with pytest.raises(CapabilityError):
        dg.detect(lambda args: True)


def test_positional_selector_guard_refuses_silent_wrong_window():
    with pytest.raises(CapabilityError):
        dg.guard_positional_selector(
            dg.LUA, ['hl.dsp.window.close("address:0xdead")']
        )


def test_positional_selector_guard_allows_named_table():
    dg.guard_positional_selector(
        dg.LUA, ['hl.dsp.window.close{ window = "address:0xdead" }']
    )
