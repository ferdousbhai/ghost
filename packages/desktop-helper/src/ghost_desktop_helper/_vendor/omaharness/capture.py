# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/capture.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Screenshot routing for Omarchy.

Two capture paths exist, and they are not equivalent:

``foreign-toplevel``
    ``grim -T <identifier>`` asks the compositor for one toplevel's own buffer.
    It is the only Stage 1 path that can photograph a window without disturbing
    the desktop, and it exists only when the installed ``grim`` advertises the
    flag *and* a bounded runtime attempt actually succeeds.

``focused-region``
    ``grim -g`` reads a rectangle of a composited output. It cannot see an
    occluded window or one on an inactive workspace, so the harness first
    focuses the target inside a :class:`~omaharness.transaction.CompositorTransaction`
    and restores the desktop afterwards. This is reported as
    ``background_safe=False`` every time, because the user would have seen it.

The harness never claims that plain ``grim -g`` captured a hidden window.
"""

from __future__ import annotations

import struct
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import process
from .errors import CapabilityError, OmaHarnessError
from .transaction import CompositorTransaction

#: A window buffer request that has not produced pixels in this long is hung.
TOPLEVEL_TIMEOUT = 2.5
REGION_TIMEOUT = 6.0


def png_size(path: Path) -> tuple[int, int]:
    """Return a PNG's pixel dimensions, rejecting truncated or foreign files."""
    with Path(path).open("rb") as handle:
        header = handle.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise OmaHarnessError(f"Capture did not produce a PNG: {path}")
    width, height = struct.unpack(">II", header[16:24])
    if width <= 0 or height <= 0:
        raise OmaHarnessError(f"Capture produced an empty PNG: {path}")
    return int(width), int(height)


def region_argument(bounds: dict[str, float]) -> str:
    """Format Hyprland window bounds as a ``grim -g`` region."""
    width = int(round(float(bounds["width"])))
    height = int(round(float(bounds["height"])))
    if width <= 0 or height <= 0:
        raise CapabilityError(
            f"Window geometry {bounds!r} has no positive area; refusing to "
            "capture a region the compositor cannot describe"
        )
    x = int(round(float(bounds["x"])))
    y = int(round(float(bounds["y"])))
    return f"{x},{y} {width}x{height}"


#: What ``grim`` says when the *pairing* cannot do foreign-toplevel capture at
#: all. These are worth latching for the session: nothing about the next window
#: will change the answer, and re-learning them costs a bounded wait each time.
UNSUPPORTED_MARKERS = (
    "doesn't support the screen capture protocol",
    "doesn't support wl_shm",
    "failed to create display",
    "compositor doesn't support",
)

#: What ``grim`` says when *this window* has no exportable buffer - it closed
#: between the list and the request, it is an XWayland client with no
#: foreign-toplevel handle, or it has never committed one. Every other window
#: on the desktop is still perfectly capturable, so this must not latch.
PER_WINDOW_MARKERS = ("cannot find toplevel",)


def classify_toplevel_failure(detail: str) -> str:
    """Say whether a failed ``grim -T`` condemns the session or one window.

    Getting this wrong in the pessimistic direction is expensive and invisible:
    a single unexportable window would silently downgrade every later capture
    to a visible focus switch, and the harness would report
    ``background_safe=False`` forever without ever saying why.
    """
    text = detail.casefold()
    if any(marker in text for marker in PER_WINDOW_MARKERS):
        return "window"
    if any(marker in text for marker in UNSUPPORTED_MARKERS):
        return "session"
    # A hung or unrecognised failure is charged to the window. The next
    # capture pays one bounded timeout to find out it was the session.
    return "window"


@dataclass
class GrimCapabilities:
    """What the installed ``grim`` can actually do."""

    installed: bool
    version: str | None = None
    advertises_toplevel: bool = False
    probe: bool | None = None
    unsupported_reason: str | None = None
    failed_identifiers: set[str] = field(default_factory=set)
    notes: list[str] = field(default_factory=list)

    @property
    def toplevel_available(self) -> bool:
        return (
            self.installed
            and self.advertises_toplevel
            and self.unsupported_reason is None
        )

    def record_success(self, identifier: str) -> None:
        self.probe = True
        self.failed_identifiers.discard(identifier)

    def record_failure(self, identifier: str, detail: str) -> str:
        """Latch a session-wide failure; remember a per-window one separately."""
        scope = classify_toplevel_failure(detail)
        if scope == "session":
            self.unsupported_reason = detail
        else:
            self.failed_identifiers.add(identifier)
        if self.probe is None:
            self.probe = False
        return scope

    def as_dict(self) -> dict[str, Any]:
        return {
            "installed": self.installed,
            "version": self.version,
            "advertises_toplevel": self.advertises_toplevel,
            "probe": self.probe,
            "toplevel_available": self.toplevel_available,
            "unsupported_reason": self.unsupported_reason,
            "windows_without_a_buffer": sorted(self.failed_identifiers),
            "notes": list(self.notes),
        }


def detect_grim(*, binary: str = "grim", runner: Any = process.run) -> GrimCapabilities:
    """Inspect ``grim`` without capturing anything."""
    if process.which(binary) is None:
        return GrimCapabilities(
            installed=False,
            notes=["grim is not installed; install it with `sudo pacman -S grim`"],
        )
    version = process.tool_version(binary)
    help_result = runner([binary, "-h"], timeout=3.0)
    help_text = f"{help_result.stdout}\n{help_result.stderr}"
    advertises = "-T" in help_text
    notes: list[str] = []
    if not advertises:
        notes.append(
            "this grim build has no -T/foreign-toplevel flag, so background "
            "window capture falls back to a visible focus switch"
        )
    return GrimCapabilities(
        installed=True,
        version=version,
        advertises_toplevel=advertises,
        notes=notes,
    )


class CaptureRouter:
    """Choose, run, and honestly label one window capture."""

    def __init__(
        self,
        hyprctl: Any,
        ydotool: Any | None = None,
        *,
        binary: str = "grim",
        runner: Any = process.run,
        transaction_factory: Any = None,
        toplevel_timeout: float = TOPLEVEL_TIMEOUT,
        region_timeout: float = REGION_TIMEOUT,
    ) -> None:
        self.hyprctl = hyprctl
        self.ydotool = ydotool
        self.binary = binary
        self.toplevel_timeout = float(toplevel_timeout)
        self.region_timeout = float(region_timeout)
        self._run = runner
        self._capabilities: GrimCapabilities | None = None
        self._transaction_factory = transaction_factory or (
            lambda: CompositorTransaction(
                self.hyprctl, self.ydotool, operation="capture", runner=self._run
            )
        )

    # --- capability ------------------------------------------------------

    def capabilities(self, *, refresh: bool = False) -> GrimCapabilities:
        if self._capabilities is None or refresh:
            self._capabilities = detect_grim(binary=self.binary, runner=self._run)
        return self._capabilities

    def require(self) -> None:
        if not self.capabilities().installed:
            raise CapabilityError(
                "grim is not installed, so omaharness cannot capture anything. "
                "Install it with `sudo pacman -S grim`."
            )

    # --- capture ---------------------------------------------------------

    @staticmethod
    def temporary_path() -> Path:
        with tempfile.NamedTemporaryFile(
            prefix="omaharness-", suffix=".png", delete=False
        ) as handle:
            output = Path(handle.name)
        output.unlink(missing_ok=True)
        return output

    def capture(
        self,
        client: dict[str, Any],
        *,
        path: str | Path | None = None,
        background_fallback: Any = None,
    ) -> dict[str, Any]:
        """Capture one window, preferring the non-disruptive path.

        ``background_fallback(client, output, warnings)`` is tried after
        foreign-toplevel capture and before the visible focus switch. It is how
        the Stage 2 headless-output path is offered without this router
        depending on it.
        """
        self.require()
        if path is None:
            output = self.temporary_path()
        else:
            output = Path(path).expanduser().resolve()
            output.parent.mkdir(parents=True, exist_ok=True)
            process.unlink_quietly(output)

        warnings: list[str] = []
        result = self.try_toplevel(client, output, warnings)
        if result is None and background_fallback is not None:
            result = background_fallback(client, output, warnings)
        if result is None:
            result = self.capture_focused_region(client, output, warnings)
        result["warnings"] = warnings + list(result.get("warnings", []))
        return result

    def try_toplevel(
        self,
        client: dict[str, Any],
        output: Path,
        warnings: list[str],
    ) -> dict[str, Any] | None:
        capabilities = self.capabilities()
        identifier = client.get("stable_id")
        name = client.get("class") or client["address"]
        if not capabilities.advertises_toplevel:
            warnings.extend(capabilities.notes)
            return None
        if capabilities.unsupported_reason is not None:
            warnings.append(
                "this compositor cannot export window buffers "
                f"({capabilities.unsupported_reason}); using the focus-switch "
                "fallback"
            )
            return None
        if not identifier:
            warnings.append(
                f"{name} has no foreign-toplevel identifier, so it cannot be "
                "captured in the background"
                + (
                    "; XWayland clients are surfaced by Xwayland rather than by "
                    "the application, and often have none"
                    if client.get("xwayland")
                    else ""
                )
            )
            return None
        if identifier in capabilities.failed_identifiers:
            warnings.append(
                f"{name} has no exportable buffer (it failed earlier in this "
                "session); other windows are still captured in the background"
            )
            return None

        result = self._run(
            [self.binary, "-t", "png", "-T", identifier, str(output)],
            timeout=self.toplevel_timeout,
        )
        if not result.ok:
            process.unlink_quietly(output)
            scope = capabilities.record_failure(identifier, result.detail())
            warnings.append(
                f"foreign-toplevel capture failed: {result.detail()}"
                + (
                    " - that is this window, not this desktop, so background "
                    "capture stays available elsewhere"
                    if scope == "window"
                    else " - background capture is unavailable for the rest of "
                    "this session"
                )
            )
            return None
        try:
            width, height = png_size(output)
        except OmaHarnessError as exc:
            process.unlink_quietly(output)
            capabilities.record_failure(identifier, str(exc))
            warnings.append(f"foreign-toplevel capture produced no image: {exc}")
            return None

        capabilities.record_success(identifier)
        return {
            "path": str(output),
            "width": width,
            "height": height,
            "backend": "grim-foreign-toplevel",
            "capture_mode": "foreign-toplevel",
            "background_safe": True,
            "interference": [],
            "client": client,
            "bounds": client.get("bounds"),
            "warnings": [],
        }

    def capture_focused_region(
        self,
        client: dict[str, Any],
        output: Path,
        warnings: list[str],
    ) -> dict[str, Any]:
        transaction = self._transaction_factory()
        with transaction:
            focused = transaction.focus_target(client)
            bounds = focused.get("bounds")
            if not bounds:
                raise CapabilityError(
                    f"Hyprland reported no usable geometry for "
                    f"{focused.get('class') or focused['address']}; refusing to "
                    "capture a guessed rectangle"
                )
            result = self._run(
                [self.binary, "-t", "png", "-g", region_argument(bounds), str(output)],
                timeout=self.region_timeout,
            )
            if not result.ok:
                process.unlink_quietly(output)
                raise OmaHarnessError(f"Window capture failed: {result.detail()}")
            try:
                width, height = png_size(output)
            except OmaHarnessError:
                process.unlink_quietly(output)
                raise
        report = transaction.report()
        return {
            "path": str(output),
            "width": width,
            "height": height,
            "backend": "grim-region",
            "capture_mode": "focused-region",
            # The window had to be visible and focused for these pixels to
            # exist. That is never a background-safe capability, even when the
            # target happened to be frontmost already.
            "background_safe": False,
            "interference": report["interference"],
            "client": focused,
            "bounds": bounds,
            "warnings": report["warnings"],
        }
