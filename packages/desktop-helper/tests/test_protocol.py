"""Protocol transport, hello handshake, op dispatch, and error shaping."""

from __future__ import annotations

import json

from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper.bridge import GhostDesktop
from ghost_desktop_helper.protocol import OPS, Server


def _desktop(**kw):
    hyprctl = kw.pop("hyprctl", None) or FakeHyprctl(_clients=[sample_window()])
    return GhostDesktop(hyprctl=hyprctl, runner=unlocked_runner, **kw)


def _server(desktop):
    return Server(desktop_factory=lambda: desktop)


def test_hello_reports_required_fields():
    payload = Server().hello()
    assert payload["type"] == "hello"
    assert payload["helper"] == "ghost-desktop-helper"
    assert "version" in payload
    assert "hyprland-version" in payload
    assert "detected-dispatch-grammar" in payload
    assert "available-backends" in payload
    # every contract op is advertised
    for op in ("see", "state", "layers", "toplevels", "ax_query", "ax_roles",
               "ax_perform", "ax_set", "key", "type", "click", "capture",
               "focus", "workspace"):
        assert op in payload["ops"]
    assert set(OPS) >= set(payload["ops"])


def test_unknown_op_is_structured_error():
    resp = _server(_desktop()).handle({"id": 7, "op": "nope"})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "unknown_op"
    assert resp["id"] == 7


def test_see_returns_windows_correlated_by_id():
    resp = _server(_desktop()).handle({"id": 1, "op": "see", "args": {}})
    assert resp["id"] == 1
    assert resp["ok"] is True
    windows = resp["result"]["windows"]
    assert len(windows) == 1
    assert windows[0]["address"] == "0xaaaa"
    assert windows[0]["focused"] is True
    assert set(windows[0]) >= {"address", "title", "class", "workspace",
                               "geometry", "focused"}


def test_state_sources_clients_and_workspaces():
    result = _server(_desktop()).handle({"id": 2, "op": "state"})["result"]
    assert result["clients"][0]["address"] == "0xaaaa"
    assert result["workspaces"]
    assert result["activewindow"]["address"] == "0xaaaa"


def test_invalid_args_object():
    resp = _server(_desktop()).handle({"id": 3, "op": "see", "args": []})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "invalid_args"


def test_response_is_json_serialisable():
    resp = _server(_desktop()).handle({"id": 4, "op": "layers"})
    json.dumps(resp)  # must not raise
    assert resp["result"]["count"] >= 1
