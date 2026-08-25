# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/session.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Session-lock detection and the single disruptive-operation lock.

Two independent safety mechanisms live here.

``lock_state`` answers "is the screen locked?" from two sources and fails
closed: if either source says locked, or if neither source can answer, mutating
input is refused. A harness that types into a lock screen is worse than a
harness that refuses to type.

``DisruptiveLock`` serialises the operations that must temporarily change
compositor state (focus, workspace, cursor). It is an ``fcntl`` lock under
``$XDG_RUNTIME_DIR`` so that two harness processes - or a harness and a
concurrent CLI call - can never interleave their snapshot/restore windows.
"""

from __future__ import annotations

import fcntl
import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from . import process
from .errors import CapabilityError, OmaHarnessError

LOCK_FILENAME = "disruptive.lock"


def runtime_dir(environ: dict[str, str] | None = None) -> Path:
    """Return the per-user runtime directory the harness locks inside."""
    env = os.environ if environ is None else environ
    base = env.get("XDG_RUNTIME_DIR")
    if not base:
        raise CapabilityError(
            "XDG_RUNTIME_DIR is unset, so omaharness cannot place its "
            "single-writer lock. Run inside the user's graphical session."
        )
    path = Path(base) / "omaharness"
    path.mkdir(parents=True, exist_ok=True)
    return path


@dataclass(frozen=True)
class LockState:
    """The combined verdict of every lock signal the harness can read."""

    hyprland: bool | None
    logind: bool | None
    sources: dict[str, str] = field(default_factory=dict)

    @property
    def locked(self) -> bool | None:
        """``True`` locked, ``False`` unlocked, ``None`` when nothing can tell."""
        if self.hyprland is True or self.logind is True:
            return True
        if self.hyprland is None and self.logind is None:
            return None
        return False

    @property
    def input_allowed(self) -> bool:
        """Fail closed: only an affirmative unlocked reading permits input."""
        return self.locked is False

    @property
    def disagreement(self) -> bool:
        return (
            self.hyprland is not None
            and self.logind is not None
            and self.hyprland != self.logind
        )

    def as_dict(self) -> dict[str, Any]:
        return {
            "hyprland": self.hyprland,
            "logind": self.logind,
            "locked": self.locked,
            "input_allowed": self.input_allowed,
            "disagreement": self.disagreement,
            "sources": dict(self.sources),
        }


def logind_locked_hint(
    *,
    runner: Any = process.run,
    environ: dict[str, str] | None = None,
) -> tuple[bool | None, str]:
    """Read ``LockedHint`` from logind, returning ``None`` when unavailable."""
    env = os.environ if environ is None else environ
    if process.which("loginctl") is None:
        return None, "loginctl is not installed"
    argv = ["loginctl", "show-session"]
    session_id = env.get("XDG_SESSION_ID")
    if session_id:
        argv.append(str(session_id))
    argv += ["-p", "LockedHint", "--value"]
    result = runner(argv, timeout=3.0)
    if not result.ok:
        return None, result.detail()
    value = (result.stdout or "").strip().casefold()
    if value in {"yes", "true", "1"}:
        return True, "LockedHint=yes"
    if value in {"no", "false", "0"}:
        return False, "LockedHint=no"
    return None, f"LockedHint reported {value!r}"


def lock_state(
    hyprctl: Any,
    *,
    runner: Any = process.run,
    environ: dict[str, str] | None = None,
) -> LockState:
    """Combine Hyprland's and logind's view of the session lock."""
    try:
        hyprland = hyprctl.locked()
        hyprland_source = "hyprctl locked"
    except OmaHarnessError as exc:
        hyprland, hyprland_source = None, str(exc)
    logind, logind_source = logind_locked_hint(runner=runner, environ=environ)
    return LockState(
        hyprland=hyprland,
        logind=logind,
        sources={"hyprland": hyprland_source, "logind": logind_source},
    )


def require_unlocked(
    hyprctl: Any,
    *,
    operation: str = "input",
    runner: Any = process.run,
    environ: dict[str, str] | None = None,
) -> LockState:
    """Raise unless both lock signals agree the session is usable."""
    state = lock_state(hyprctl, runner=runner, environ=environ)
    if state.locked is True:
        raise CapabilityError(
            f"Refusing {operation}: the session reports a locked screen "
            f"(hyprland={state.hyprland}, logind={state.logind}). "
            "Unlock the session and retry."
        )
    if state.locked is None:
        raise CapabilityError(
            f"Refusing {operation}: neither hyprctl nor logind could determine "
            "whether the screen is locked "
            f"({state.sources.get('hyprland')}; {state.sources.get('logind')}). "
            "omaharness fails closed rather than typing into an unknown session."
        )
    return state


class DisruptiveLock:
    """An ``fcntl`` lock guarding every operation that changes desktop state."""

    def __init__(
        self,
        *,
        directory: Path | None = None,
        timeout: float = 10.0,
        poll: float = 0.05,
    ) -> None:
        self._directory = directory
        self.timeout = float(timeout)
        self.poll = float(poll)
        self._handle: Any = None

    @property
    def path(self) -> Path:
        directory = runtime_dir() if self._directory is None else Path(self._directory)
        directory.mkdir(parents=True, exist_ok=True)
        return directory / LOCK_FILENAME

    def acquire(self) -> None:
        path = self.path
        handle = path.open("a+")
        deadline = time.monotonic() + self.timeout
        while True:
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                if time.monotonic() >= deadline:
                    handle.close()
                    raise OmaHarnessError(
                        f"Another omaharness operation held {path} for more than "
                        f"{self.timeout:g}s; refusing to interleave desktop state changes"
                    ) from None
                time.sleep(self.poll)
                continue
            break
        handle.seek(0)
        handle.truncate()
        handle.write(f"{os.getpid()}\n")
        handle.flush()
        self._handle = handle

    def release(self) -> None:
        handle, self._handle = self._handle, None
        if handle is None:
            return
        try:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        except OSError:  # pragma: no cover - the fd is going away anyway
            pass
        finally:
            handle.close()

    def __enter__(self) -> DisruptiveLock:
        self.acquire()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.release()
