# Vendored from omarchy-quattro-harness at commit 5bc268d7558971fbbe4570f6c04cf62a67f93d42.
# Original module: src/omaharness/process.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE.
# Modified by Ghost to bound combined captured child output.

"""Bounded subprocess execution.

Every external command the harness runs - ``hyprctl``, ``grim``, ``ydotool``,
``loginctl``, ``bash`` - goes through :func:`run`. It always applies time and
combined-output limits, always runs the child in its own process group, and
always kills that whole group when either limit expires. A hung or noisy
``grim`` must never wedge the persistent Python session.
"""

from __future__ import annotations

import os
import selectors
import shutil
import signal
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

DEFAULT_TIMEOUT = 5.0
DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
_READ_CHUNK_BYTES = 64 * 1024

#: How a tool answers when it has no version flag. Several of the harness's
#: dependencies exit 0 while doing this - ``hyprctl --version`` prints its
#: usage, ``grim --version`` prints "invalid option" - so the exit status is
#: not enough to tell a version from a complaint about being asked for one.
_NOT_A_VERSION = (
    "usage:",
    "usage :",
    "invalid option",
    "unrecognized option",
    "unknown option",
    "command not found",
    "no such file",
)


@dataclass(frozen=True)
class CommandResult:
    """The complete outcome of one bounded command."""

    argv: tuple[str, ...]
    returncode: int
    stdout: str
    stderr: str
    timed_out: bool = False
    output_limited: bool = False

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out and not self.output_limited

    def detail(self) -> str:
        """Return the most useful single-line explanation of a failure."""
        if self.timed_out:
            return f"{self.argv[0]} timed out"
        if self.output_limited:
            return f"{self.argv[0]} output exceeded the capture limit"
        text = (self.stderr or self.stdout or "").strip()
        return text or f"{self.argv[0]} exited with status {self.returncode}"


def run(
    argv: list[str] | tuple[str, ...],
    *,
    timeout: float = DEFAULT_TIMEOUT,
    input: str | None = None,  # noqa: A002 - mirrors subprocess.run
    env: dict[str, str] | None = None,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
) -> CommandResult:
    """Run one command with hard time and combined-output limits.

    Output is consumed incrementally from both pipes. Crossing the combined
    byte ceiling terminates the entire child process group, just like a
    timeout, so a noisy command cannot grow the persistent harness process
    without bound.
    """
    argv = tuple(str(item) for item in argv)
    if max_output_bytes <= 0:
        raise ValueError("max_output_bytes must be positive")
    try:
        child = subprocess.Popen(  # noqa: S603 - argv is a list, never a shell string
            argv,
            stdin=subprocess.PIPE if input is not None else subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            bufsize=0,
            start_new_session=True,
            env=env,
        )
    except FileNotFoundError:
        return CommandResult(argv, 127, "", f"{argv[0]}: command not found")
    except OSError as exc:  # pragma: no cover - platform specific
        return CommandResult(argv, 126, "", f"{argv[0]}: {exc}")

    stdout, stderr, timed_out, output_limited = _capture_bounded(
        child,
        input_data=input.encode() if input is not None else None,
        timeout=timeout,
        max_output_bytes=max_output_bytes,
    )
    return CommandResult(
        argv,
        int(child.returncode if child.returncode is not None else -1),
        stdout.decode(errors="replace"),
        stderr.decode(errors="replace"),
        timed_out=timed_out,
        output_limited=output_limited,
    )


def _capture_bounded(
    child: subprocess.Popen[bytes],
    *,
    input_data: bytes | None,
    timeout: float,
    max_output_bytes: int,
) -> tuple[bytes, bytes, bool, bool]:
    """Stream a child's pipes into a fixed-size combined capture budget."""
    selector = selectors.DefaultSelector()
    captures: dict[str, list[bytes]] = {"stdout": [], "stderr": []}
    captured_bytes = 0
    input_offset = 0
    timed_out = False
    output_limited = False
    deadline = time.monotonic() + timeout

    for name, stream in (("stdout", child.stdout), ("stderr", child.stderr)):
        if stream is None:  # pragma: no cover - Popen contract above
            continue
        os.set_blocking(stream.fileno(), False)
        selector.register(stream, selectors.EVENT_READ, name)

    if child.stdin is not None:
        if input_data:
            os.set_blocking(child.stdin.fileno(), False)
            selector.register(child.stdin, selectors.EVENT_WRITE, "stdin")
        else:
            child.stdin.close()

    try:
        while selector.get_map():
            remaining_time = deadline - time.monotonic()
            if remaining_time <= 0:
                timed_out = True
                break

            events = selector.select(remaining_time)
            if not events:
                timed_out = child.poll() is None
                if timed_out:
                    break
                continue

            for key, _ in events:
                stream = key.fileobj
                if key.data == "stdin":
                    try:
                        written = os.write(
                            stream.fileno(),
                            input_data[input_offset : input_offset + _READ_CHUNK_BYTES],
                        )
                        input_offset += written
                    except (BrokenPipeError, BlockingIOError, OSError):
                        input_offset = len(input_data)
                    if input_offset >= len(input_data):
                        selector.unregister(stream)
                        stream.close()
                    continue

                try:
                    chunk = os.read(stream.fileno(), _READ_CHUNK_BYTES)
                except BlockingIOError:
                    continue
                except OSError:
                    chunk = b""

                if not chunk:
                    selector.unregister(stream)
                    stream.close()
                    continue

                remaining_output = max_output_bytes - captured_bytes
                if remaining_output > 0:
                    kept = chunk[:remaining_output]
                    captures[key.data].append(kept)
                    captured_bytes += len(kept)
                if len(chunk) > remaining_output:
                    output_limited = True
                    break

            if output_limited:
                break

        if timed_out or output_limited:
            _terminate_group(child)
        elif child.poll() is None:
            try:
                child.wait(timeout=max(0.0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                timed_out = True
                _terminate_group(child)
    finally:
        for key in list(selector.get_map().values()):
            stream = key.fileobj
            try:
                selector.unregister(stream)
            except (KeyError, ValueError):
                pass
            try:
                stream.close()
            except OSError:
                pass
        selector.close()

    return (
        b"".join(captures["stdout"]),
        b"".join(captures["stderr"]),
        timed_out,
        output_limited,
    )


def _terminate_group(process: subprocess.Popen[bytes]) -> None:
    """Kill the child and everything it spawned, then reap it."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        try:
            os.killpg(os.getpgid(process.pid), sig)
        except (ProcessLookupError, PermissionError, OSError):
            return
        try:
            process.wait(timeout=0.5)
            return
        except subprocess.TimeoutExpired:
            continue


def which(name: str) -> str | None:
    """Return the absolute path of an executable, or ``None`` when absent."""
    return shutil.which(name)


def tool_version(name: str, *, flag: str = "--version") -> str | None:
    """Return a one-line version string for a dependency, or ``None``.

    A tool that rejects the flag has not told us its version, so this reports
    ``None`` rather than the first line of its error text. ``doctor`` prints
    what comes back verbatim, and "unknown" is a far more useful diagnostic
    than a usage message dressed up as a version number.
    """
    if which(name) is None:
        return None
    result = run([name, flag], timeout=3.0)
    if not result.ok:
        return None
    text = (result.stdout or result.stderr).strip()
    if not text:
        return None
    line = text.splitlines()[0].strip()
    lowered = line.casefold()
    if any(marker in lowered for marker in _NOT_A_VERSION):
        return None
    return line


def unlink_quietly(path: Path | str | None) -> None:
    """Delete a partial artifact without ever raising."""
    if path is None:
        return
    try:
        Path(path).unlink(missing_ok=True)
    except OSError:  # pragma: no cover - unlikely filesystem failure
        pass
