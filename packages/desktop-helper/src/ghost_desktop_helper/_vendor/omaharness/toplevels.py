# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/toplevels.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""A minimal ``ext-foreign-toplevel-list-v1`` client.

The harness learns about windows from ``hyprctl clients``, which is authoritative
about layout - workspaces, geometry, focus history - and completely
Hyprland-specific. It is also not the list that ``grim -T`` consults. ``grim``
binds ``ext_foreign_toplevel_list_v1`` and matches on the ``identifier`` event,
so the only way to know whether a window can be photographed in the background
is to ask the same protocol ``grim`` will ask.

This module speaks that protocol directly over the compositor's socket: no
libwayland, no bindings, no build step. It reads and never mutates - the only
requests it makes are ``get_registry``, ``sync``, and ``bind``, none of which
change anything a user could see.

Two things fall out of that, and both matter more than the window list itself:

* ``supported`` answers "can this compositor export window buffers at all?"
  without spending a bounded ``grim`` timeout to find out.
* an identifier that appears here but not in ``hyprctl clients`` (or the other
  way round) is the exact discrepancy that makes a background capture fail.
"""

from __future__ import annotations

import os
import select
import socket
import struct
import time
from dataclasses import dataclass, field
from typing import Any

INTERFACE = "ext_foreign_toplevel_list_v1"

#: Wire ids we allocate. The client half of the id space starts at 1, and
#: ``wl_display`` is always 1.
_DISPLAY = 1
_REGISTRY = 2
_FIRST_CALLBACK = 3
_LIST = 4
_SECOND_CALLBACK = 5

# wl_display requests
_SYNC = 0
_GET_REGISTRY = 1
# wl_display events
_ERROR = 0
# wl_registry
_BIND = 0
_GLOBAL = 0
# wl_callback
_DONE = 0
# ext_foreign_toplevel_list_v1 events
_TOPLEVEL = 0
_FINISHED = 1
# ext_foreign_toplevel_handle_v1 events
_CLOSED = 0
_HANDLE_DONE = 1
_TITLE = 2
_APP_ID = 3
_IDENTIFIER = 4

DEFAULT_TIMEOUT = 1.5


@dataclass(frozen=True)
class Toplevel:
    """One window as the capture protocol sees it."""

    identifier: str
    app_id: str = ""
    title: str = ""

    def as_dict(self) -> dict[str, Any]:
        return {
            "identifier": self.identifier,
            "app_id": self.app_id,
            "title": self.title,
        }


@dataclass(frozen=True)
class ToplevelList:
    """The result of one read-only conversation with the compositor."""

    supported: bool
    toplevels: tuple[Toplevel, ...] = ()
    error: str | None = None
    globals_seen: int = 0

    @property
    def identifiers(self) -> frozenset[str]:
        return frozenset(item.identifier for item in self.toplevels if item.identifier)

    def as_dict(self) -> dict[str, Any]:
        return {
            "protocol": INTERFACE,
            "supported": self.supported,
            "count": len(self.toplevels),
            "toplevels": [item.as_dict() for item in self.toplevels],
            "error": self.error,
        }


def socket_path(environ: dict[str, str] | None = None) -> str | None:
    """Return the compositor socket, or ``None`` when there is no session."""
    env = os.environ if environ is None else environ
    display = env.get("WAYLAND_DISPLAY")
    if not display:
        return None
    if display.startswith("/"):
        return display
    runtime = env.get("XDG_RUNTIME_DIR")
    if not runtime:
        return None
    return os.path.join(runtime, display)


# --- wire encoding ---------------------------------------------------------


def _string(value: str) -> bytes:
    """Encode a Wayland string: length including NUL, then 32-bit padding."""
    raw = value.encode("utf-8") + b"\x00"
    padding = (-len(raw)) % 4
    return struct.pack("<I", len(raw)) + raw + b"\x00" * padding


def _message(object_id: int, opcode: int, body: bytes = b"") -> bytes:
    size = 8 + len(body)
    return struct.pack("<II", object_id, (size << 16) | opcode) + body


def _read_string(body: bytes, offset: int) -> tuple[str, int]:
    (length,) = struct.unpack_from("<I", body, offset)
    offset += 4
    text = body[offset : offset + max(0, length - 1)].decode("utf-8", "replace")
    return text, offset + length + ((-length) % 4)


@dataclass
class _Handle:
    identifier: str = ""
    app_id: str = ""
    title: str = ""
    closed: bool = False


@dataclass
class _Session:
    """Parser state for one connection."""

    handles: dict[int, _Handle] = field(default_factory=dict)
    list_name: int | None = None
    list_version: int = 1
    globals_seen: int = 0
    error: str | None = None
    first_sync_done: bool = False
    second_sync_done: bool = False


def _dispatch(state: _Session, object_id: int, opcode: int, body: bytes) -> None:
    if object_id == _DISPLAY and opcode == _ERROR:
        _, code = struct.unpack_from("<II", body, 0)
        message, _ = _read_string(body, 8)
        state.error = f"wl_display error {code}: {message}"
        return
    if object_id == _REGISTRY and opcode == _GLOBAL:
        (name,) = struct.unpack_from("<I", body, 0)
        interface, offset = _read_string(body, 4)
        (version,) = struct.unpack_from("<I", body, offset)
        state.globals_seen += 1
        if interface == INTERFACE and state.list_name is None:
            state.list_name = name
            state.list_version = max(1, min(1, version))
        return
    if object_id == _FIRST_CALLBACK and opcode == _DONE:
        state.first_sync_done = True
        return
    if object_id == _SECOND_CALLBACK and opcode == _DONE:
        state.second_sync_done = True
        return
    if object_id == _LIST:
        if opcode == _TOPLEVEL:
            (handle_id,) = struct.unpack_from("<I", body, 0)
            state.handles[handle_id] = _Handle()
        elif opcode == _FINISHED:
            state.second_sync_done = True
        return
    handle = state.handles.get(object_id)
    if handle is None:
        return
    if opcode == _IDENTIFIER:
        handle.identifier, _ = _read_string(body, 0)
    elif opcode == _APP_ID:
        handle.app_id, _ = _read_string(body, 0)
    elif opcode == _TITLE:
        handle.title, _ = _read_string(body, 0)
    elif opcode == _CLOSED:
        handle.closed = True
    elif opcode == _HANDLE_DONE:
        pass


def _pump(
    connection: socket.socket, state: _Session, deadline: float, until: Any
) -> bool:
    """Read events until ``until(state)`` is true, the peer goes away, or time runs out."""
    buffer = bytearray()
    while not until(state) and state.error is None:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        readable, _, _ = select.select([connection], [], [], remaining)
        if not readable:
            return False
        try:
            # File descriptors can ride along on any message; the harness needs
            # none of them, and dropping them keeps this a pure byte stream.
            chunk, _, _, _ = connection.recvmsg(4096, socket.CMSG_SPACE(64))
        except OSError as exc:
            state.error = str(exc)
            return False
        if not chunk:
            return False
        buffer.extend(chunk)
        while len(buffer) >= 8:
            object_id, header = struct.unpack_from("<II", buffer, 0)
            size = header >> 16
            if size < 8 or len(buffer) < size:
                break
            _dispatch(state, object_id, header & 0xFFFF, bytes(buffer[8:size]))
            del buffer[:size]
    return until(state)


def list_toplevels(
    *,
    environ: dict[str, str] | None = None,
    timeout: float = DEFAULT_TIMEOUT,
    connector: Any = None,
) -> ToplevelList:
    """Ask the compositor for the windows it will let a client photograph.

    Never raises: a compositor that does not implement the protocol, a missing
    session, and a socket that stops answering are all reported, because every
    one of them is a real answer to "why was this capture not background safe?"
    """
    if connector is not None:
        connection = connector()
    else:
        path = socket_path(environ)
        if path is None:
            return ToplevelList(False, error="no WAYLAND_DISPLAY in this environment")
        try:
            connection = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            connection.connect(path)
        except OSError as exc:
            return ToplevelList(False, error=f"cannot reach the compositor: {exc}")

    deadline = time.monotonic() + max(0.05, float(timeout))
    state = _Session()
    try:
        connection.sendall(
            _message(_DISPLAY, _GET_REGISTRY, struct.pack("<I", _REGISTRY))
            + _message(_DISPLAY, _SYNC, struct.pack("<I", _FIRST_CALLBACK))
        )
        if not _pump(connection, state, deadline, lambda s: s.first_sync_done):
            return ToplevelList(
                False,
                error=state.error or "the compositor did not finish advertising globals",
                globals_seen=state.globals_seen,
            )
        if state.error is not None:
            return ToplevelList(False, error=state.error, globals_seen=state.globals_seen)
        if state.list_name is None:
            return ToplevelList(
                False,
                error=(
                    f"this compositor does not advertise {INTERFACE}, so no client "
                    "can enumerate or photograph windows in the background"
                ),
                globals_seen=state.globals_seen,
            )

        connection.sendall(
            _message(
                _REGISTRY,
                _BIND,
                struct.pack("<I", state.list_name)
                + _string(INTERFACE)
                + struct.pack("<II", state.list_version, _LIST),
            )
            + _message(_DISPLAY, _SYNC, struct.pack("<I", _SECOND_CALLBACK))
        )
        _pump(connection, state, deadline, lambda s: s.second_sync_done)
    except OSError as exc:
        return ToplevelList(False, error=str(exc), globals_seen=state.globals_seen)
    finally:
        try:
            connection.close()
        except OSError:  # pragma: no cover - closing a dead socket
            pass

    toplevels = tuple(
        Toplevel(handle.identifier, handle.app_id, handle.title)
        for handle in state.handles.values()
        if handle.identifier and not handle.closed
    )
    return ToplevelList(
        True, toplevels, error=state.error, globals_seen=state.globals_seen
    )


__all__ = ["INTERFACE", "Toplevel", "ToplevelList", "list_toplevels", "socket_path"]
