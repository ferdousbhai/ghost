"""Is the AT-SPI accessibility bus actually there?

libatspi resolves the bus through ``org.a11y.Bus.GetAddress`` on the session
bus and then connects. When the launcher answers with an address nobody is
listening on, libatspi does not raise: it ``g_error``s and the whole helper
aborts with SIGABRT. So every accessibility path asks this module first and
refuses with a plain ``capability`` error instead.
"""

from __future__ import annotations

import os
import socket
from typing import Any

REMEDIATION = [
    "Start the accessibility bus for this session: "
    "`/usr/lib/at-spi-bus-launcher --launch-immediately &` "
    "(package at-spi2-core), then retry.",
]


def _address_from_session_bus(timeout_ms: int) -> str:
    from gi.repository import Gio, GLib  # type: ignore[import-not-found]

    bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
    reply = bus.call_sync(
        "org.a11y.Bus",
        "/org/a11y/bus",
        "org.a11y.Bus",
        "GetAddress",
        None,
        GLib.VariantType("(s)"),
        Gio.DBusCallFlags.NONE,
        timeout_ms,
        None,
    )
    return str(reply.unpack()[0])


def socket_path(address: str) -> str | None:
    """The unix socket named by a D-Bus address, or None for other transports."""
    for part in address.split(";"):
        transport, _, rest = part.partition(":")
        if transport != "unix":
            continue
        for item in rest.split(","):
            key, _, value = item.partition("=")
            if key in ("path", "abstract") and value:
                return value if key == "path" else "\0" + value
    return None


def problem(timeout_ms: int = 3000) -> str | None:
    """Why the accessibility bus cannot be used right now, or None when it can."""
    address = os.environ.get("AT_SPI_BUS_ADDRESS") or ""
    if not address:
        try:
            address = _address_from_session_bus(timeout_ms)
        except Exception as exc:  # noqa: BLE001 - any failure means "not reachable"
            return f"org.a11y.Bus did not answer on the session bus: {exc}"
    path = socket_path(address)
    if path is None:
        return f"accessibility bus address is not a unix socket: {address}"
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
            probe.settimeout(timeout_ms / 1000)
            probe.connect(path)
    except OSError as exc:
        return f"nothing is listening on the accessibility bus at {address}: {exc}"
    return None


def diagnosis(binding: dict[str, Any]) -> dict[str, Any]:
    """Fold bus reachability into the binding diagnosis for `hello`."""
    if not binding.get("available"):
        return binding
    reason = problem()
    if reason is None:
        return binding
    return {**binding, "available": False, "reason": reason, "remediation": REMEDIATION}
