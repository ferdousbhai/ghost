"""Live, read-only tests against the real compositor.

Gated behind GHOST_DESKTOP_LIVE=1 so CI and dev boxes without a session skip
them. Every test here is deliberately non-disruptive: it does not steal focus,
inject input into real windows, or switch the workspace. The one grammar check
that touches ``hyprctl dispatch`` uses a fake window address so the dispatcher
runs but changes nothing.
"""

from __future__ import annotations

import base64
import os

import pytest

pytestmark = pytest.mark.skipif(
    os.environ.get("GHOST_DESKTOP_LIVE") != "1",
    reason="live compositor tests need GHOST_DESKTOP_LIVE=1",
)

from omaharness import dispatch as dg  # noqa: E402
from omaharness import hypr, process  # noqa: E402

from ghost_desktop_helper.bridge import GhostDesktop  # noqa: E402
from ghost_desktop_helper.protocol import Server  # noqa: E402


@pytest.fixture(scope="module")
def desktop():
    return GhostDesktop()


def test_hello_detects_lua_grammar_on_this_machine():
    payload = Server().hello()
    grammar = payload["detected-dispatch-grammar"]
    assert grammar["generation"] == dg.LUA, grammar
    version = payload["hyprland-version"]
    assert version and "0.56" in version["tag"], version


def test_state_is_populated(desktop):
    state = desktop.state()
    assert isinstance(state["clients"], list)
    assert state["workspaces"]
    assert state["activeworkspace"]["id"] is not None


def test_toplevels_reconcile(desktop):
    report = desktop.toplevels()
    assert report["protocol"] == "ext_foreign_toplevel_list_v1"
    assert report["supported"] is True
    assert "background_capturable" in report


def test_layers_present(desktop):
    result = desktop.layers()
    assert result["count"] >= 1


def test_emitted_focus_grammar_parses_on_this_compositor(desktop):
    """The core fix: the string the helper WOULD emit must parse on 0.56.2.

    Uses a fake address so the dispatcher runs against nothing. A valid grammar
    answers 'warning: ... not found'; the OLD broken string grammar answered a
    Lua 'error: ... expected'. Assert we are on the right side of that line and
    that the user's real focus never moved.
    """
    active_before = desktop.hyprctl.active_window()
    encoded = desktop.hyprctl.encoder.focus_window("0xdeadbeef")
    assert encoded == ['hl.dsp.focus{ window = "address:0xdeadbeef" }']
    reply = process.run(["hyprctl", "dispatch", *encoded], timeout=3.0)
    text = (reply.stdout + reply.stderr).strip().casefold()
    assert "not found" in text, text          # grammar parsed, window absent
    assert not text.startswith("error"), text  # NOT a Lua parse error
    active_after = desktop.hyprctl.active_window()
    assert (active_before or {}).get("address") == (active_after or {}).get("address")


def test_capture_active_window_background_safe(desktop):
    active = desktop.hyprctl.active_window()
    if active is None:
        pytest.skip("no active window to capture")
    # allow_headless_capture off + capturing the already-focused, visible window
    # keeps this non-disruptive.
    desktop.allow_headless_capture = False
    result = desktop.capture(target="window", address=active["address"])
    png = base64.b64decode(result["png_base64"])
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    assert result["width"] > 0 and result["height"] > 0
    assert set(result) >= {"backend", "background_safe", "interference", "warnings"}


def test_ax_query_against_any_gtk_app(desktop):
    """Find one AT-SPI-exposing window and query it read-only, or skip."""
    from omaharness import atspi as atspi_module

    if not atspi_module.available():
        pytest.skip("PyGObject/AT-SPI bindings not importable")
    for client in desktop.hyprctl.clients():
        try:
            result = desktop.ax_query(app=client["address"], limit=5)
        except Exception:  # noqa: BLE001 - app without an AT-SPI tree; try next
            continue
        if result["count"] >= 1 or result.get("warnings"):
            assert "app" in result
            return
    pytest.skip("no AT-SPI-exposing window found in this session")


def test_ax_ref_resolves_then_stales_on_the_real_bus(desktop):
    """The P0 fix, end to end on the real bindings, without disrupting anyone.

    Proves the ax_query -> ref -> resolve path (the read half ax_perform relies
    on) works on live AT-SPI, and that a second snapshot renders the earlier
    ref stale rather than silently redirecting it. The actual do_action is
    deliberately NOT invoked, so no real window is clicked or focus stolen.
    """
    from omaharness import atspi as atspi_module

    from ghost_desktop_helper.bridge import UnknownRefError

    if not atspi_module.available():
        pytest.skip("PyGObject/AT-SPI bindings not importable")

    d = GhostDesktop()  # a private instance so module-scoped state is untouched
    for client in d.hyprctl.clients():
        try:
            result = d.ax_query(app=client["address"], limit=5)
        except Exception:  # noqa: BLE001 - app without an AT-SPI tree; try next
            continue
        if result["count"] < 1:
            continue
        ref = result["elements"][0]["ref"]
        assert ":" in str(ref)  # epoch-qualified, not a bare index
        assert d._ax_element(ref) is not None  # resolves on the live bus
        epoch = d._ax_epoch

        # A second snapshot bumps the epoch; the earlier ref is now stale.
        d.ax_roles(app=client["address"])
        assert d._ax_epoch == epoch + 1
        with pytest.raises(UnknownRefError) as exc:
            d.ax_perform(ref=ref)
        assert exc.value.details["reason"] == "stale"
        return
    pytest.skip("no AT-SPI-exposing window with a resolvable ref found")
