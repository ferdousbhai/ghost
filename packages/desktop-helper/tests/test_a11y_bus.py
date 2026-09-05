"""The accessibility bus is checked before libatspi can abort the helper."""

from __future__ import annotations

import pytest
from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper import a11y_bus
from ghost_desktop_helper._vendor.omaharness.errors import CapabilityError
from ghost_desktop_helper.bridge import GhostDesktop


def test_socket_path_reads_unix_addresses():
    assert a11y_bus.socket_path("unix:path=/run/user/1000/at-spi/bus_0") == "/run/user/1000/at-spi/bus_0"
    assert a11y_bus.socket_path("unix:abstract=a11y,guid=1") == "\0a11y"
    assert a11y_bus.socket_path("tcp:host=localhost,port=1") is None


def test_dead_socket_is_a_problem(tmp_path, monkeypatch):
    monkeypatch.setenv("AT_SPI_BUS_ADDRESS", f"unix:path={tmp_path / 'bus_0'}")
    reason = a11y_bus.problem()
    assert reason is not None and "nothing is listening" in reason


def test_ax_op_refuses_with_capability_instead_of_touching_atspi(monkeypatch):
    monkeypatch.setattr(a11y_bus, "problem", lambda timeout_ms=3000: "nothing is listening on the accessibility bus")
    desktop = GhostDesktop(hyprctl=FakeHyprctl(_clients=[sample_window(pid=4242)]), runner=unlocked_runner)
    with pytest.raises(CapabilityError) as raised:
        desktop._ax_backend()
    assert "at-spi-bus-launcher" in str(raised.value)


def test_hello_reports_the_dead_bus(monkeypatch):
    monkeypatch.setattr(a11y_bus, "problem", lambda timeout_ms=3000: "nothing is listening")
    report = a11y_bus.diagnosis({"available": True, "interpreter": "3.14", "reason": None, "remediation": []})
    assert report["available"] is False
    assert report["remediation"] == a11y_bus.REMEDIATION
