# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/transaction.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See vendor/omaharness/LICENSE for the full text. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""The disruptive-operation transaction.

Stage 1 cannot inject input or capture an inactive window without briefly
changing what the user sees: ``ydotool`` follows compositor focus, and
``grim -g`` can only read pixels that are actually composited. The honest way
to do that is a transaction:

1. take the single-writer lock,
2. refuse outright if the session might be locked,
3. snapshot workspace, focus, target geometry, and cursor,
4. do the disruptive work,
5. restore everything in ``finally``, and
6. report exactly what interference the user would have seen.

The cursor is the one thing the harness will not force back. If the physical
pointer no longer sits where the harness left it, a human moved it mid-flight;
yanking it away would be worse than leaving it. That case reports the race and
raises :class:`~omaharness.errors.StateRestoreError`.
"""

from __future__ import annotations

import time
from typing import Any

from . import process, session
from .errors import OmaHarnessError, StateRestoreError

#: How far the physical cursor may drift from the harness's own last injected
#: position before restoration is treated as a user race rather than a restore.
CURSOR_TOLERANCE = 4.0


def hidden_workspace_name(workspace: dict[str, Any] | None) -> str | None:
    """Name the workspace when it is one the user cannot see, else ``None``.

    Hyprland parks a window on a *special* workspace to put it out of sight -
    Omarchy's minimize is ``special:minimized``, and scratchpads work the same
    way. Such a workspace carries a ``special`` name and a negative id; either
    signal alone is enough, because a compositor that reports one without the
    other should still be treated as hiding the window.
    """
    if not workspace:
        return None
    name = workspace.get("name")
    identifier = workspace.get("id")
    if isinstance(name, str) and name.startswith("special"):
        return name
    if isinstance(identifier, int) and identifier < 0:
        return name if isinstance(name, str) else f"workspace {identifier}"
    return None


class CompositorTransaction:
    """Snapshot, disrupt, restore - with an explicit interference report."""

    def __init__(
        self,
        hyprctl: Any,
        ydotool: Any | None = None,
        *,
        operation: str = "input",
        lock: session.DisruptiveLock | None = None,
        runner: Any = process.run,
        settle: float = 0.08,
        sleep: Any = time.sleep,
        cursor_tolerance: float = CURSOR_TOLERANCE,
        require_unlocked: bool = True,
    ) -> None:
        self.hyprctl = hyprctl
        self.ydotool = ydotool
        self.operation = operation
        self.lock = session.DisruptiveLock() if lock is None else lock
        self.settle = float(settle)
        self.cursor_tolerance = float(cursor_tolerance)
        self._runner = runner
        self._sleep = sleep
        self._require_unlocked = require_unlocked
        self.snapshot: dict[str, Any] = {}
        self.warnings: list[str] = []
        self.interference: list[str] = []
        self.lock_state: session.LockState | None = None
        self._expected_cursor: tuple[float, float] | None = None
        self._unhidden: list[tuple[str, str]] = []
        self._entered = False

    # --- lifecycle -------------------------------------------------------

    def __enter__(self) -> CompositorTransaction:
        self.lock.acquire()
        try:
            if self._require_unlocked:
                self.lock_state = session.require_unlocked(
                    self.hyprctl, operation=self.operation, runner=self._runner
                )
            self.snapshot = self._take_snapshot()
        except BaseException:
            self.lock.release()
            raise
        self._entered = True
        return self

    def __exit__(self, exc_type: Any, exc: Any, traceback: Any) -> bool:
        try:
            failures = self._restore()
        finally:
            self.lock.release()
            self._entered = False
        if not failures:
            return False
        message = "; ".join(failures)
        if exc_type is not None:
            # Never mask the original failure - surface the restore problem
            # alongside it in the operation's warnings.
            self.warnings.append(f"state restore incomplete: {message}")
            return False
        raise StateRestoreError(f"Could not restore desktop state: {message}")

    # --- snapshot and restore -------------------------------------------

    def _take_snapshot(self) -> dict[str, Any]:
        active_window = self.hyprctl.active_window()
        snapshot: dict[str, Any] = {
            "workspace": self.hyprctl.active_workspace(),
            "focused_address": (
                active_window.get("address") if active_window else None
            ),
            # Hyprland keeps a window *focused* after minimizing it, so the
            # focused window at snapshot time can be one the user deliberately
            # put away. Record where it lives, because that decides whether
            # restoring focus to it is a restore or a fresh disruption.
            "focused_hidden_on": hidden_workspace_name(
                (active_window or {}).get("workspace")
            ),
            "cursor": None,
        }
        try:
            snapshot["cursor"] = self.hyprctl.cursor_position()
        except OmaHarnessError as exc:
            self.warnings.append(f"cursor position unavailable at snapshot: {exc}")
        return snapshot

    def _restore(self) -> list[str]:
        failures: list[str] = []
        # Re-hide first. Putting the window back before the workspace and focus
        # restores means those two land on the desktop the user actually had,
        # instead of one with an extra window on it.
        for address, hidden_on in reversed(self._unhidden):
            try:
                self.hyprctl.move_window_to_workspace(
                    hidden_on, address, follow=False
                )
            except OmaHarnessError as exc:
                failures.append(f"{address} not returned to {hidden_on} ({exc})")
        self._unhidden.clear()
        workspace = (self.snapshot.get("workspace") or {}).get("id")
        if "workspace-switch" in self.interference and workspace is not None:
            try:
                self.hyprctl.focus_workspace(workspace)
            except OmaHarnessError as exc:
                failures.append(f"workspace {workspace} not restored ({exc})")
        address = self.snapshot.get("focused_address")
        hidden_on = self.snapshot.get("focused_hidden_on")
        if "focus-change" in self.interference and address and hidden_on:
            # Focusing a window on a special workspace drags it back into view.
            # The restore would then *be* the disruption it exists to undo, and
            # the receipt would report background_safe for a window the user
            # had put away. Leave it hidden and say so, exactly as the cursor
            # is left where a user moved it.
            self.warnings.append(
                f"focus was not restored to {address}: it sits on {hidden_on}, "
                "and focusing it would pull a window the user had put away "
                "back onto a visible workspace"
            )
        elif "focus-change" in self.interference and address:
            try:
                self.hyprctl.focus_window(address)
            except OmaHarnessError as exc:
                failures.append(f"focus {address} not restored ({exc})")
        failures.extend(self._restore_cursor())
        return failures

    def _restore_cursor(self) -> list[str]:
        original = self.snapshot.get("cursor")
        if self._expected_cursor is None or original is None:
            return []
        try:
            current = self.hyprctl.cursor_position()
        except OmaHarnessError as exc:
            return [f"cursor position unreadable ({exc})"]
        drift = max(
            abs(current[0] - self._expected_cursor[0]),
            abs(current[1] - self._expected_cursor[1]),
        )
        if drift > self.cursor_tolerance:
            return [
                "the physical pointer moved during the transaction "
                f"(expected {self._expected_cursor}, found {current}); "
                "omaharness left it where the user put it"
            ]
        if self.ydotool is None:
            return ["no input backend available to restore the cursor"]
        try:
            self.ydotool.move_absolute(*original)
        except OmaHarnessError as exc:
            return [f"cursor not restored to {original} ({exc})"]
        return []

    # --- disruptive steps ------------------------------------------------

    def note(self, kind: str) -> None:
        if kind not in self.interference:
            self.interference.append(kind)

    def focus_target(self, client: dict[str, Any]) -> dict[str, Any]:
        """Bring one window forward, then re-read its geometry.

        Returns the *refreshed* client: a window that was on another workspace
        or tiled differently can land at coordinates that do not match the
        pre-switch snapshot, and capturing the stale rectangle would silently
        photograph the wrong pixels.
        """
        self._require_entered()
        address = client["address"]
        workspace = client.get("workspace") or {}
        hidden_on = hidden_workspace_name(workspace)
        active = (self.snapshot.get("workspace") or {}).get("id")
        if hidden_on:
            # A window parked on a special workspace has no id the `workspace`
            # dispatcher accepts: focus_workspace(-99) is a malformed selector,
            # not a switch to special:minimized. focus_window is what actually
            # brings such a window forward, and un-hiding it is the side effect
            # that does the work. That is visible, so it gets its own
            # interference kind, and the window goes back where it was on the
            # way out - otherwise the transaction would leave the user's
            # minimized window sitting open.
            self.note("window-unhide")
            self._unhidden.append((address, hidden_on))
        else:
            identifier = workspace.get("id")
            if identifier is not None and identifier != active:
                self.note("workspace-switch")
                self.hyprctl.focus_workspace(identifier)
                self._sleep(self.settle)
        if self.snapshot.get("focused_address") != address:
            self.note("focus-change")
        self.hyprctl.focus_window(address)
        self._sleep(self.settle)
        for candidate in self.hyprctl.clients():
            if candidate["address"] == address:
                return candidate
        raise OmaHarnessError(
            f"Window {address} disappeared while {self.operation} was in flight"
        )

    def move_pointer(self, x: float, y: float, *, settle: bool = True) -> None:
        """Move the physical pointer and remember where the harness left it."""
        self._require_entered()
        if self.ydotool is None:
            raise OmaHarnessError("Pointer movement requires the ydotool backend")
        self.note("pointer-move")
        self.ydotool.move_absolute(x, y)
        self._expected_cursor = (float(x), float(y))
        if settle:
            self._sleep(self.settle)

    def _require_entered(self) -> None:
        if not self._entered:
            raise OmaHarnessError(
                "CompositorTransaction steps must run inside the `with` block"
            )

    # --- reporting -------------------------------------------------------

    def report(self) -> dict[str, Any]:
        return {
            "background_safe": not self.interference,
            "interference": list(self.interference),
            "warnings": list(self.warnings),
        }
