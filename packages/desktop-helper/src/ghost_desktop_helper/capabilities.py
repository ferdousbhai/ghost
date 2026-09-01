"""Backend / capability detection for the hello handshake.

Everything here is read-only and never raises: a missing tool is a first-class,
reported outcome (the helper degrades and says so), not a crash. The hello
handshake is the ghost's one chance to learn what this machine can actually do
before it asks for anything, so the detection is honest about partial
capability rather than optimistic.
"""

from __future__ import annotations

from typing import Any

from ._vendor.omaharness import atspi as atspi_module
from ._vendor.omaharness import capture as capture_module
from ._vendor.omaharness import hypr, inputs, process
from ._vendor.omaharness import toplevels as toplevel_protocol
from ._vendor.omaharness.errors import OmaHarnessError


def _tool(name: str) -> dict[str, Any]:
    path = process.which(name)
    return {
        "available": path is not None,
        "path": path,
        "version": process.tool_version(name) if path else None,
    }


def detect_backends(hyprctl: hypr.Hyprctl | None = None) -> dict[str, Any]:
    """Report which capture / input / accessibility backends are usable."""
    grim = capture_module.detect_grim()
    ydotool_status = inputs.socket_status()
    atspi = atspi_module.binding_diagnosis()

    backends: dict[str, Any] = {
        "hyprctl": _tool("hyprctl"),
        "grim": {
            **_tool("grim"),
            "foreign_toplevel": grim.toplevel_available,
            "notes": grim.notes,
        },
        "wtype": _tool("wtype"),
        "ydotool": {
            **_tool("ydotool"),
            "socket": ydotool_status.as_dict(),
            # ydotool is the only injected-input backend; without it the helper
            # can still observe, capture, sendshortcut chords, and type via
            # wtype, but raw coordinate clicks / evdev chords refuse.
            "usable": ydotool_status.exists and ydotool_status.problem is None,
        },
        "atspi": {
            "available": atspi.get("available", False),
            "interpreter": atspi.get("interpreter"),
            "reason": atspi.get("reason"),
            "remediation": atspi.get("remediation", []),
        },
    }

    # ext-foreign-toplevel-list-v1 support decides whether background-safe
    # window capture is even possible; probe it read-only.
    try:
        listing = toplevel_protocol.list_toplevels(timeout=1.0)
        backends["foreign_toplevel_protocol"] = {
            "supported": listing.supported,
            "error": listing.error,
        }
    except Exception as exc:  # noqa: BLE001 - detection never raises
        backends["foreign_toplevel_protocol"] = {
            "supported": False,
            "error": str(exc),
        }
    return backends


def dispatch_grammar_info(hyprctl: hypr.Hyprctl) -> dict[str, Any]:
    """Return the detected dispatcher grammar and the evidence for it."""
    try:
        return hyprctl.dispatch_api()
    except OmaHarnessError as exc:
        return {"generation": None, "detected_by": "error", "evidence": str(exc)}


def hyprland_version(hyprctl: hypr.Hyprctl) -> dict[str, Any] | None:
    try:
        return hyprctl.version()
    except OmaHarnessError:
        return None
