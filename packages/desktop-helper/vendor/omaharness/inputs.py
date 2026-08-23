# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/inputs.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See vendor/omaharness/LICENSE for the full text. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Focused input injection, wrapped so every call is bounded and diagnosable.

Two backends live here because they fail in opposite directions, and the split
between them is not a preference:

* :class:`Ydotool` writes evdev key *codes* into ``uinput``. A code is a
  physical key position, so the character it produces is whatever the layout
  the compositor applies to that device says it produces. That is exactly what
  a compositor keybind matches on, which makes it the only way to fire one -
  and exactly the wrong thing for text.
* :class:`Wtype` uploads its own XKB keymap containing the characters it was
  asked to type, then presses positions in that keymap. The text that lands is
  the text that was passed, on any layout - but the keymap is synthetic, so
  Hyprland does not match binds against it.

So: ``ydotool`` for chords, ``wtype`` for text. Neither is background-safe on
its own - both inject into whatever the compositor currently focuses - so
callers must wrap them in a
:class:`omaharness.transaction.CompositorTransaction` that takes focus
deliberately and restores it afterwards.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from . import process
from .errors import CapabilityError, OmaHarnessError
from .keys import evdev_chord

#: ``ydotool click`` button numbers and its down/up bit flags.
_BUTTONS = {"left": 0x00, "right": 0x01, "middle": 0x02}
_DOWN, _UP = 0x40, 0x80

#: Where the pointer is sent to measure the absolute-coordinate mapping, in
#: logical layout coordinates. Two probes are needed because the mapping can
#: carry an offset as well as a scale, and both are small enough that neither
#: sample can come back clamped to a screen edge under any plausible factor -
#: a clamped sample would be indistinguishable from a wrong one.
_CALIBRATION_PROBES = (120.0, 240.0)

#: How far the realised pointer may sit from the requested coordinate before
#: the move counts as failed. One logical pixel is lost to integer rounding in
#: the ``ydotool`` argument itself, so the floor here cannot be zero.
POINTER_TOLERANCE = 2.0

#: Corrective retries after a verified move lands off-target. A correct scale
#: lands the first correction; more than this means something non-linear.
_MAX_POINTER_CORRECTIONS = 2


@dataclass(frozen=True)
class PointerCalibration:
    """The measured affine map from requested to realised pointer coordinates.

    ``ydotool mousemove --absolute`` does not promise layout pixels. It writes
    ``ABS_X``/``ABS_Y`` into a ``uinput`` device, and what those values mean on
    screen depends on the axis range that device declares and on how the
    compositor maps it. A device whose declared maximum disagrees with the one
    ``ydotool`` assumes lands every pointer at a fixed multiple of the target -
    silently, and with a successful exit code.

    So the map is measured rather than assumed. It is a property of this device
    on this compositor, and it is cheap to establish once per session.
    """

    scale_x: float
    scale_y: float
    offset_x: float
    offset_y: float

    def request_for(self, x: float, y: float) -> tuple[float, float]:
        """Return the coordinate to ask for so the pointer lands on ``(x, y)``."""
        return (
            (float(x) - self.offset_x) / self.scale_x,
            (float(y) - self.offset_y) / self.scale_y,
        )

    def is_identity(self, tolerance: float = 0.01) -> bool:
        return (
            abs(self.scale_x - 1.0) <= tolerance
            and abs(self.scale_y - 1.0) <= tolerance
            and abs(self.offset_x) <= POINTER_TOLERANCE
            and abs(self.offset_y) <= POINTER_TOLERANCE
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "scale_x": round(self.scale_x, 4),
            "scale_y": round(self.scale_y, 4),
            "offset_x": round(self.offset_x, 2),
            "offset_y": round(self.offset_y, 2),
            "identity": self.is_identity(),
        }

_SOCKET_HINT = (
    "Start it with `systemctl --user enable --now ydotool` (Omarchy ships a "
    "user unit) and make sure the socket is owned by your user."
)


@dataclass(frozen=True)
class SocketStatus:
    """Ownership and permissions of the ``ydotoold`` socket."""

    path: str | None
    exists: bool
    owner_uid: int | None = None
    mode: str | None = None
    writable: bool = False
    problem: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "path": self.path,
            "exists": self.exists,
            "owner_uid": self.owner_uid,
            "mode": self.mode,
            "writable": self.writable,
            "problem": self.problem,
        }


def socket_path(environ: dict[str, str] | None = None) -> str | None:
    env = os.environ if environ is None else environ
    explicit = env.get("YDOTOOL_SOCKET")
    if explicit:
        return explicit
    runtime = env.get("XDG_RUNTIME_DIR")
    if runtime:
        return str(Path(runtime) / ".ydotool_socket")
    return None


def socket_status(environ: dict[str, str] | None = None) -> SocketStatus:
    """Describe the ``ydotoold`` socket without touching it."""
    path = socket_path(environ)
    if path is None:
        return SocketStatus(None, False, problem="XDG_RUNTIME_DIR is unset")
    target = Path(path)
    try:
        info = target.stat()
    except OSError as exc:
        return SocketStatus(path, False, problem=f"{exc.strerror}; {_SOCKET_HINT}")
    owner = int(info.st_uid)
    mode = stat.filemode(info.st_mode)
    writable = os.access(target, os.W_OK)
    problem = None
    if owner != os.getuid():
        problem = (
            f"socket is owned by uid {owner}, not {os.getuid()}; "
            "a root-owned ydotoold cannot be driven from this session"
        )
    elif not writable:
        problem = f"socket mode {mode} is not writable by this user"
    return SocketStatus(path, True, owner, mode, writable, problem)


class Ydotool:
    """A thin, bounded wrapper over the ``ydotool`` CLI."""

    def __init__(
        self,
        *,
        binary: str = "ydotool",
        runner: Any = process.run,
        timeout: float = 5.0,
        key_delay_ms: int = 12,
        position_reader: Callable[[], tuple[float, float]] | None = None,
    ) -> None:
        self.binary = binary
        self.timeout = float(timeout)
        self.key_delay_ms = int(key_delay_ms)
        self._run = runner
        # Without a way to read the pointer back, moves stay open-loop: the
        # harness cannot verify a coordinate it has no means of observing, and
        # pretending otherwise is worse than admitting it.
        self._position_reader = position_reader
        self._calibration: PointerCalibration | None = None
        self._calibration_error: str | None = None

    # --- capability ------------------------------------------------------

    def available(self) -> bool:
        return process.which(self.binary) is not None

    def require(self) -> None:
        if not self.available():
            raise CapabilityError(
                "ydotool is not installed. Install it with `sudo pacman -S ydotool`."
            )
        status = socket_status()
        if not status.exists or status.problem:
            raise CapabilityError(
                f"ydotoold is not usable: {status.problem or 'socket missing'}. "
                f"{_SOCKET_HINT}"
            )

    def _call(self, args: list[str], *, input: str | None = None) -> None:  # noqa: A002
        result = self._run(
            [self.binary, *args], timeout=self.timeout, input=input
        )
        if not result.ok:
            raise OmaHarnessError(f"ydotool {args[0]} failed: {result.detail()}")

    # --- pointer ---------------------------------------------------------

    def move_absolute(self, x: float, y: float) -> None:
        """Move the physical cursor to an absolute layout coordinate.

        With a position reader wired in this is closed-loop: ask, read back
        where the pointer actually went, correct. A click is only ever as
        truthful as its coordinate, so a move that cannot be verified to have
        landed raises instead of reporting success.
        """
        target = (float(x), float(y))
        if self._position_reader is None:
            self._raw_move(*target)
            return

        calibration = self.calibrate()
        assert calibration is not None  # a reader is present, so one exists
        request = calibration.request_for(*target)
        actual = target
        for _ in range(_MAX_POINTER_CORRECTIONS + 1):
            self._raw_move(*request)
            actual = self._position_reader()
            error = (target[0] - actual[0], target[1] - actual[1])
            if max(abs(error[0]), abs(error[1])) <= POINTER_TOLERANCE:
                return
            request = (
                request[0] + error[0] / calibration.scale_x,
                request[1] + error[1] / calibration.scale_y,
            )
        raise OmaHarnessError(
            f"pointer did not reach {target}: it stopped at {actual} after "
            f"{_MAX_POINTER_CORRECTIONS} corrections. A target outside the "
            "reachable area of the screen looks exactly like this."
        )

    def _raw_move(self, x: float, y: float) -> None:
        self._call(
            ["mousemove", "--absolute", "-x", str(int(round(x))), "-y", str(int(round(y)))]
        )

    def calibrate(self, *, force: bool = False) -> PointerCalibration | None:
        """Measure how requested absolute coordinates reach the compositor.

        Moves the physical pointer twice, so it belongs inside a transaction
        that has already declared ``pointer-move`` interference. Callers that
        only want to *report* the mapping must read
        :meth:`calibration_report` instead, which never moves anything.
        """
        if self._position_reader is None:
            return None
        if self._calibration is not None and not force:
            return self._calibration

        low, high = _CALIBRATION_PROBES
        first = self._probe(low)
        second = self._probe(high)
        span = high - low
        scale_x = (second[0] - first[0]) / span
        scale_y = (second[1] - first[1]) / span
        # Two probes landing on one pixel means the pointer never moved - a
        # dead ydotoold, a compositor that ignores the device - and a zero
        # scale would divide by zero on the very next move.
        if not scale_x or not scale_y:
            self._calibration_error = (
                f"absolute pointer probes at {low} and {high} both landed on "
                f"{first}; the pointer is not responding to ydotool"
            )
            raise OmaHarnessError(self._calibration_error)

        self._calibration = PointerCalibration(
            scale_x=scale_x,
            scale_y=scale_y,
            offset_x=first[0] - scale_x * low,
            offset_y=first[1] - scale_y * low,
        )
        self._calibration_error = None
        return self._calibration

    def _probe(self, value: float) -> tuple[float, float]:
        assert self._position_reader is not None
        self._raw_move(value, value)
        return self._position_reader()

    def calibration_report(self) -> dict[str, Any]:
        """Report the mapping without touching the pointer."""
        return {
            "readable": self._position_reader is not None,
            "measured": (
                self._calibration.as_dict() if self._calibration else None
            ),
            "error": self._calibration_error,
        }

    def click(self, button: str = "left", *, clicks: int = 1) -> None:
        code = self._button(button)
        for _ in range(max(1, int(clicks))):
            self._call(["click", f"0x{code | _DOWN | _UP:02X}"])

    def button_down(self, button: str = "left") -> None:
        self._call(["click", f"0x{self._button(button) | _DOWN:02X}"])

    def button_up(self, button: str = "left") -> None:
        self._call(["click", f"0x{self._button(button) | _UP:02X}"])

    def scroll(self, delta_y: int, delta_x: int = 0) -> None:
        """Emit wheel deltas; positive ``delta_y`` scrolls up."""
        self._call(
            ["mousemove", "--wheel", "-x", str(int(delta_x)), "-y", str(int(delta_y))]
        )

    @staticmethod
    def _button(button: str) -> int:
        try:
            return _BUTTONS[button.casefold()]
        except KeyError as exc:
            raise OmaHarnessError(
                f"Unknown mouse button {button!r}; use left, right, or middle"
            ) from exc

    # --- keyboard --------------------------------------------------------

    def type(self, text: str) -> None:
        if not text:
            return
        self._call(
            ["type", "--key-delay", str(self.key_delay_ms), "--file", "-"], input=text
        )

    def key(self, chord: str) -> None:
        """Press one chord as explicit evdev down/up transitions."""
        modifiers, key = evdev_chord(chord)
        sequence = [f"{code}:1" for code in modifiers]
        sequence += [f"{key}:1", f"{key}:0"]
        sequence += [f"{code}:0" for code in reversed(modifiers)]
        self._call(["key", *sequence])


class Wtype:
    """Layout-safe text injection over the virtual-keyboard protocol.

    Typing text with ``ydotool`` is a silent correctness bug on any layout but
    US. ``ydotool type`` resolves each character to a US key position and sends
    that *position*; the compositor then interprets it through the layout the
    keyboard actually has. On a ``br`` layout the position US calls ``/``
    carries ``;``, so ``nvim /tmp/notes.md`` is delivered as
    ``nvim ;tmp;notes.md`` - with a successful exit code, because from
    ``ydotool``'s side nothing went wrong.

    ``wtype`` builds an XKB keymap containing the exact characters it was asked
    for, uploads it with the keystrokes, and tears it down. Nothing is resolved
    against the user's layout, so no layout can corrupt it. It handles the full
    range this matters for: ASCII punctuation, accented Latin, and arbitrary
    Unicode alike.

    The cost of that synthetic keymap is that Hyprland does not match keybinds
    against it - ``super+m`` typed through ``wtype`` reaches the focused
    surface and fires no bind. Chords therefore stay on :class:`Ydotool`.
    """

    def __init__(
        self,
        *,
        binary: str = "wtype",
        runner: Any = process.run,
        timeout: float = 30.0,
        key_delay_ms: int = 12,
    ) -> None:
        self.binary = binary
        self.timeout = float(timeout)
        self.key_delay_ms = int(key_delay_ms)
        self._run = runner

    # --- capability ------------------------------------------------------

    def available(self) -> bool:
        return process.which(self.binary) is not None

    def require(self) -> None:
        if not self.available():
            raise CapabilityError(
                "wtype is not installed, and it is what types text without a "
                "keyboard-layout dependency. Install it with "
                "`sudo pacman -S wtype`."
            )

    # --- keyboard --------------------------------------------------------

    def type(self, text: str) -> None:
        """Type ``text`` verbatim into whatever the compositor focuses.

        The text goes over stdin rather than ``argv`` so that a leading ``-``
        is content, not an option: ``wtype`` has no ``--`` terminator, and a
        note that begins with a dash is ordinary text to want typed.
        """
        if not text:
            return
        result = self._run(
            [self.binary, "-d", str(self.key_delay_ms), "-"],
            timeout=self.timeout,
            input=text,
        )
        if not result.ok:
            raise OmaHarnessError(f"wtype failed: {result.detail()}")
