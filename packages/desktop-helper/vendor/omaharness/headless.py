# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/headless.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See vendor/omaharness/LICENSE for the full text. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Stage 2: crash-recoverable headless-output capture.

When foreign-toplevel capture is unavailable and the target is hidden, the only
way to obtain real pixels is to make the compositor render the window
somewhere. Instead of hijacking the user's screen, Stage 2 creates a temporary
headless output, parks the window on it, captures, and tears everything down.

The dangerous part is a crash mid-transaction: a window stranded on an output
that no longer exists is a wrecked desktop. Every step is therefore journalled
to ``$XDG_RUNTIME_DIR`` *before* it happens, and any stale journal is recovered
before new work begins.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from . import process, session
from .errors import CapabilityError, OmaHarnessError
from .transaction import hidden_workspace_name

JOURNAL_NAME = "headless-transaction.json"
CAPTURE_WORKSPACE = "omaharness-capture"


class HeadlessCapture:
    """Capture a hidden window on a disposable headless output."""

    def __init__(
        self,
        hyprctl: Any,
        *,
        runner: Any = process.run,
        binary: str = "grim",
        journal: Path | None = None,
        settle: float = 0.12,
        sleep: Any = time.sleep,
        timeout: float = 8.0,
        layout_timeout: float = 3.0,
    ) -> None:
        self.hyprctl = hyprctl
        self.binary = binary
        self.settle = float(settle)
        self.timeout = float(timeout)
        self.layout_timeout = float(layout_timeout)
        self._run = runner
        self._sleep = sleep
        self._journal = journal

    @property
    def journal_path(self) -> Path:
        if self._journal is not None:
            return Path(self._journal)
        return session.runtime_dir() / JOURNAL_NAME

    # --- journal ---------------------------------------------------------

    def _write_journal(self, entry: dict[str, Any]) -> None:
        path = self.journal_path
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entry, indent=2), encoding="utf-8")

    def _clear_journal(self) -> None:
        process.unlink_quietly(self.journal_path)

    def pending(self) -> dict[str, Any] | None:
        """Return an interrupted transaction, or ``None``. Never raises.

        ``doctor`` calls this, so a missing runtime directory or an unreadable
        journal must degrade to "nothing pending" rather than break diagnostics.
        """
        try:
            payload = json.loads(self.journal_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError, CapabilityError):
            return None
        return payload if isinstance(payload, dict) else None

    def recover(self) -> dict[str, Any] | None:
        """Undo an interrupted transaction. Safe to call when none exists."""
        entry = self.pending()
        if entry is None:
            return None
        warnings = self._put_everything_back(entry, entry.get("output"))
        self._clear_journal()
        return {
            "recovered": True,
            "started_at": entry.get("created_at"),
            "address": entry.get("address"),
            "warnings": warnings,
        }

    # --- output plumbing -------------------------------------------------

    def _output_names(self) -> set[str]:
        return {monitor["name"] for monitor in self.hyprctl.monitors()}

    def _create_output(self) -> str:
        before = self._output_names()
        self.hyprctl.call(["output", "create", "headless"], timeout=self.timeout)
        self._sleep(self.settle)
        after = self._output_names()
        created = sorted(after - before)
        if not created:
            raise CapabilityError(
                "Hyprland did not create a headless output; this build may not "
                "support `hyprctl output create headless`"
            )
        return created[0]

    def _remove_output(self, name: str) -> None:
        if name in self._output_names():
            self.hyprctl.call(["output", "remove", name], timeout=self.timeout)

    @staticmethod
    def _inside(bounds: dict[str, Any] | None, monitor: dict[str, Any]) -> bool:
        """Is this window's rectangle within this output's rectangle?"""
        if not bounds:
            return False
        origin_x = float(monitor.get("x") or 0.0)
        origin_y = float(monitor.get("y") or 0.0)
        scale = float(monitor.get("scale") or 1.0) or 1.0
        width = float(monitor.get("width") or 0.0) / scale
        height = float(monitor.get("height") or 0.0) / scale
        slack = 2.0
        return (
            float(bounds["x"]) >= origin_x - slack
            and float(bounds["y"]) >= origin_y - slack
            and float(bounds["x"]) + float(bounds["width"])
            <= origin_x + width + slack
            and float(bounds["y"]) + float(bounds["height"])
            <= origin_y + height + slack
        )

    def _await_window_on_output(self, address: str, output: str) -> dict[str, Any]:
        """Wait for the window's geometry to actually reach the new output.

        A fixed sleep is the wrong tool here and was measured to be wrong: on
        this compositor ``hyprctl clients`` reports the new *monitor* almost
        immediately but keeps serving the window's old coordinates for roughly
        four times the previous settle. Capturing on that first read crops the
        old rectangle - which is still on the user's real screen - and hands it
        back labelled as a background capture of their window. So poll the
        thing being relied on, and give up loudly rather than early.
        """
        deadline = time.monotonic() + self.layout_timeout
        client = self._client(address)
        while True:
            monitor = self._monitor(output)
            if self._inside(client.get("bounds"), monitor):
                return client
            if time.monotonic() >= deadline:
                raise CapabilityError(
                    f"The window's geometry never moved onto {output} within "
                    f"{self.layout_timeout:g}s (last seen at "
                    f"{client.get('bounds')}, output at {monitor.get('x')},"
                    f"{monitor.get('y')}); refusing to capture the old rectangle"
                )
            self._sleep(self.settle)
            client = self._client(address)

    def _monitor(self, name: str) -> dict[str, Any]:
        for monitor in self.hyprctl.monitors():
            if monitor.get("name") == name:
                return monitor
        raise OmaHarnessError(f"Headless output {name} vanished during capture")

    def _crop_to_window(
        self, path: Path, bounds: dict[str, Any], monitor: dict[str, Any]
    ) -> tuple[int, int]:
        """Cut the window out of a full-output capture, or refuse.

        The bounds check is the point. If the window is not inside the output
        this transaction created, then it never moved there, and the PNG in
        hand is a picture of something else - quite possibly the user's real
        screen. Cropping blindly would hand back those pixels labelled as a
        background capture of their window, which is the exact failure this
        module exists to avoid. Refuse and let the caller fall back visibly.
        """
        from PIL import Image

        origin_x = float(monitor.get("x") or 0.0)
        origin_y = float(monitor.get("y") or 0.0)
        scale = float(monitor.get("scale") or 1.0)
        left = (float(bounds["x"]) - origin_x) * scale
        top = (float(bounds["y"]) - origin_y) * scale
        right = left + float(bounds["width"]) * scale
        bottom = top + float(bounds["height"]) * scale

        with Image.open(path) as source:
            image = source.convert("RGBA")
            pixel_width, pixel_height = image.size
            slack = 2.0
            if (
                left < -slack
                or top < -slack
                or right > pixel_width + slack
                or bottom > pixel_height + slack
            ):
                raise CapabilityError(
                    "The window did not land inside the headless output "
                    f"({monitor.get('name')}): its bounds map to "
                    f"({left:.0f},{top:.0f})-({right:.0f},{bottom:.0f}) in a "
                    f"{pixel_width}x{pixel_height} capture. Refusing to return "
                    "pixels that may not be this window"
                )
            box = (
                max(0, int(round(left))),
                max(0, int(round(top))),
                min(pixel_width, int(round(right))),
                min(pixel_height, int(round(bottom))),
            )
            if box[2] - box[0] < 1 or box[3] - box[1] < 1:
                raise CapabilityError(
                    "The window occupies no pixels on the headless output"
                )
            cropped = image.crop(box)
            # A window can land on the headless output and still render
            # nothing: measured on Hyprland 0.56.2, the output composites the
            # wallpaper and the bar while the window's own surface stays
            # unmapped, and the crop comes back one flat colour. That is not a
            # capture of the window, and returning it as background_safe with
            # no warnings would be a confident answer to a question this route
            # did not manage to answer. Refuse, and let the caller fall back to
            # the visible path that does work.
            if len(cropped.convert("RGB").getcolors(maxcolors=2) or [None, None]) == 1:
                raise CapabilityError(
                    "The headless output rendered no content for this window - "
                    "the capture is a single flat colour. This compositor did "
                    "not compose the window's surface onto the temporary "
                    "output; falling back to a visible capture"
                )
            cropped.save(path)
            return cropped.size

    def _client(self, address: str) -> dict[str, Any]:
        for client in self.hyprctl.clients():
            if client["address"] == address:
                return client
        raise OmaHarnessError(f"Window {address} disappeared during capture")

    # --- capture ---------------------------------------------------------

    def capture(
        self,
        client: dict[str, Any],
        output_path: str | Path,
        *,
        lock: session.DisruptiveLock | None = None,
    ) -> dict[str, Any]:
        """Render one window on a temporary output and capture it."""
        address = client["address"]
        path = Path(output_path)
        guard = session.DisruptiveLock() if lock is None else lock
        warnings: list[str] = []
        with guard:
            session.require_unlocked(
                self.hyprctl, operation="headless capture", runner=self._run
            )
            # Recovery moves windows and removes outputs, so it is disruptive
            # work and belongs under the same lock as the capture it precedes.
            # Run outside, it can interleave with another harness transaction
            # and undo a restore that transaction is midway through.
            recovered = self.recover()
            if recovered:
                warnings.append(
                    "recovered an interrupted headless capture before starting: "
                    f"{recovered['address']}"
                )
                warnings.extend(recovered["warnings"])
            active_window = self.hyprctl.active_window()
            home = client.get("workspace") or {}
            home_hidden = hidden_workspace_name(home)
            entry = {
                "created_at": time.time(),
                "address": address,
                "workspace": home.get("id"),
                "workspace_name": home.get("name"),
                # The id is not a usable selector for a special workspace:
                # Hyprland reads a negative workspace number as *relative*, so
                # sending the window "back" to -99 files it somewhere the user
                # never put it. The name is what addresses special:minimized.
                "workspace_selector": home_hidden
                if home_hidden is not None
                else home.get("id"),
                "fullscreen": client.get("fullscreen", 0),
                "focused_address": (
                    active_window.get("address") if active_window else None
                ),
                "focused_hidden_on": hidden_workspace_name(
                    (active_window or {}).get("workspace")
                ),
                "active_workspace": self.hyprctl.active_workspace().get("id"),
                "capture_workspace": CAPTURE_WORKSPACE,
                "output": None,
            }
            self._write_journal(entry)
            output = None
            try:
                output = self._create_output()
                entry["output"] = output
                self._write_journal(entry)

                self.hyprctl.move_window_to_workspace(
                    f"name:{CAPTURE_WORKSPACE}", address
                )
                self.hyprctl.move_workspace_to_monitor(
                    f"name:{CAPTURE_WORKSPACE}", output
                )
                self._sleep(self.settle)

                parked = self._await_window_on_output(address, output)
                bounds = parked.get("bounds")
                if not bounds:
                    raise CapabilityError(
                        "The window reported no geometry on the headless output; "
                        "refusing to capture a guessed rectangle"
                    )
                # grim rejects -o together with -g as mutually exclusive, so
                # this route has to pick one. It must be -o. A bare -g resolves
                # the region against whatever output covers those layout
                # coordinates, and Hyprland places the headless output where it
                # can overlap the real one - which silently photographs the
                # user's actual screen and reports it as a background capture
                # of their window. Capture the output we made, then crop to the
                # window inside it, where the coordinates are unambiguous.
                result = self._run(
                    [self.binary, "-t", "png", "-o", output, str(path)],
                    timeout=self.timeout,
                )
                if not result.ok:
                    process.unlink_quietly(path)
                    raise OmaHarnessError(
                        f"Headless capture failed: {result.detail()}"
                    )
                width, height = self._crop_to_window(
                    path, bounds, self._monitor(output)
                )
            finally:
                restore_warnings = self._put_everything_back(entry, output)
                warnings.extend(restore_warnings)
                self._clear_journal()

        return {
            "path": str(path),
            "width": width,
            "height": height,
            "backend": "hyprland-headless-output",
            "capture_mode": "headless-output",
            # The window rendered on an output that only existed inside this
            # transaction, so a *complete* run reached none of the user's
            # screens. An incomplete restore is the opposite: a window left on
            # a phantom workspace, or an output still attached, is exactly the
            # visible mess background_safe is supposed to promise did not
            # happen. Report what the restore actually achieved.
            "background_safe": not restore_warnings,
            "interference": (
                ["incomplete-restore"] if restore_warnings else []
            ),
            "client": parked,
            "bounds": bounds,
            "warnings": warnings,
        }

    def _put_everything_back(
        self, entry: dict[str, Any], output: str | None
    ) -> list[str]:
        """Undo the capture. One implementation, so a crash restores what a
        clean run restores - a second copy is a second place to get it wrong.
        """
        warnings: list[str] = []
        address = entry.get("address")
        selector = entry.get("workspace_selector")
        if selector is None:
            # A journal written by an older harness records only the id. Derive
            # the selector the same way, so an interrupted upgrade still
            # restores rather than silently leaving the window parked.
            selector = hidden_workspace_name(
                {"id": entry.get("workspace"), "name": entry.get("workspace_name")}
            )
            if selector is None:
                selector = entry.get("workspace")
        if address and selector is not None:
            try:
                self.hyprctl.move_window_to_workspace(selector, address)
            except OmaHarnessError as exc:
                warnings.append(f"window not returned to workspace {selector}: {exc}")
        if output:
            try:
                self._remove_output(output)
            except OmaHarnessError as exc:
                warnings.append(f"headless output {output} not removed: {exc}")
        focused = entry.get("focused_address")
        hidden_on = entry.get("focused_hidden_on")
        if focused and hidden_on:
            # Same trap the compositor transaction guards: Hyprland leaves a
            # minimized window focused, and focusing it again drags it back
            # into view. Restoring focus here would put a window the user had
            # put away back on their screen - and this function's whole job is
            # to leave no trace.
            warnings.append(
                f"focus was not restored to {focused}: it sits on {hidden_on}, "
                "and focusing it would pull a window the user had put away "
                "back onto a visible workspace"
            )
        elif focused:
            try:
                self.hyprctl.focus_window(focused)
            except OmaHarnessError as exc:
                warnings.append(f"focus not restored to {focused}: {exc}")
        return warnings
