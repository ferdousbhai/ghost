"""Protocol transport, hello handshake, op dispatch, and error shaping."""

from __future__ import annotations

import io
import json

import pytest
from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper._vendor.omaharness.errors import (
    AmbiguousTargetError,
    CapabilityError,
    OmaHarnessError,
    StateRestoreError,
)
from ghost_desktop_helper.bridge import GhostDesktop, UnknownRefError
from ghost_desktop_helper.protocol import (
    DESKTOP_HELPER_PROTOCOL_VERSION,
    OPS,
    Server,
    _error_code,
)


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
    assert payload["protocol"] == DESKTOP_HELPER_PROTOCOL_VERSION
    assert "hyprland-version" in payload
    assert "detected-dispatch-grammar" in payload
    assert "available-backends" in payload
    for op in ("see", "state", "layers", "toplevels", "ax_query", "ax_roles",
               "ax_perform", "ax_set", "hit_test", "key", "type", "click",
               "drag", "scroll", "mouse_move", "capture", "focus", "workspace"):
        assert op in payload["ops"]
    assert set(OPS) >= set(payload["ops"])


def test_unknown_op_is_structured_error():
    resp = _server(_desktop()).handle({"id": 7, "op": "nope"})
    assert resp["ok"] is False
    assert resp["error"]["code"] == "unknown_op"
    assert resp["id"] == 7


def test_hello_is_the_only_diagnostic_op():
    server = _server(_desktop())
    hello = server.handle({"id": 8, "op": "hello"})
    doctor = server.handle({"id": 9, "op": "doctor"})

    assert hello["ok"] is True
    assert hello["result"]["type"] == "hello"
    assert doctor["ok"] is False
    assert doctor["error"]["code"] == "unknown_op"
    assert "doctor" not in OPS


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


def test_stale_ref_maps_to_unknown_ref_code_with_details():
    server = _server(_desktop())
    resp = server.handle(
        {"id": 5, "op": "ax_perform", "args": {"ref": "99:0"}}
    )
    assert resp["ok"] is False
    assert resp["error"]["code"] == "unknown_ref"
    # The structured details forwarded from UnknownRefError distinguish a stale
    # ref from a never-minted one.
    assert resp["error"]["details"]["reason"] == "stale"
    json.dumps(resp)  # still serialisable


@pytest.mark.parametrize(
    ("error", "code"),
    [
        (UnknownRefError("stale"), "unknown_ref"),
        (CapabilityError("missing"), "capability"),
        (AmbiguousTargetError("ambiguous"), "ambiguous_target"),
        (StateRestoreError("restore"), "state_restore"),
        (OmaHarnessError("failure"), "harness"),
        (ValueError("bad value"), "invalid_args"),
        (RuntimeError("unexpected"), "internal"),
    ],
)
def test_error_code_precedence_is_explicit(error: BaseException, code: str):
    assert _error_code(error) == code


def test_keyboard_interrupt_is_not_swallowed_into_a_json_error():
    class Boom(GhostDesktop):
        def state(self):  # noqa: D401 - test stub
            raise KeyboardInterrupt

    server = _server(Boom(hyprctl=FakeHyprctl(_clients=[sample_window()]),
                          runner=unlocked_runner))
    with pytest.raises(KeyboardInterrupt):
        server.handle({"id": 6, "op": "state"})


def test_run_serves_the_line_transport():
    """Drive the real stdio loop: unsolicited hello, then one response per line."""
    desktop = _desktop()
    stdin = io.StringIO(
        '{"id": 1, "op": "state"}\n'
        "\n"
        "not json\n"
        "[1, 2]\n"
    )
    stdout = io.StringIO()
    server = Server(
        stdin=stdin, stdout=stdout, stderr=io.StringIO(),
        desktop_factory=lambda: desktop,
    )
    assert server.run() == 0

    lines = [json.loads(line) for line in stdout.getvalue().splitlines()]
    assert lines[0]["type"] == "hello"
    assert lines[1]["id"] == 1 and lines[1]["ok"] is True
    assert lines[2]["ok"] is False
    assert lines[2]["error"]["code"] == "invalid_json"
    assert lines[3]["ok"] is False
    assert lines[3]["error"]["code"] == "invalid_request"
