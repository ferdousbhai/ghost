# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/hypr.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Hyprland inspection and dispatch through bounded ``hyprctl`` calls.

Everything the harness knows about windows, monitors, workspaces, focus, and
the physical cursor comes from here. All JSON is validated before it reaches
the rest of the harness: a malformed or truncated ``hyprctl`` reply raises
instead of degrading into ``0`` coordinates that later look like real geometry.
"""

from __future__ import annotations

import json
import os
from typing import Any

from . import dispatch as dispatch_grammar
from . import process
from .errors import CapabilityError, OmaHarnessError

#: ``hyprctl clients -j`` has carried the foreign-toplevel handle under
#: different names across releases, and older builds do not expose it at all.
#: A missing identifier is an ordinary, tested outcome - it disables the
#: non-disruptive capture path rather than producing a guessed value.
_STABLE_ID_KEYS = (
    "foreignToplevelIdentifier",
    "toplevelIdentifier",
    "xdgToplevelIdentifier",
    "stableId",
    "identifier",
)


def _fail(what: str, detail: str) -> OmaHarnessError:
    return OmaHarnessError(f"hyprctl {what} returned unusable data: {detail}")


def _as_int(value: Any, default: int | None = None) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return int(value)
    if isinstance(value, str):
        try:
            return int(value.strip())
        except ValueError:
            return default
    return default


def _as_float(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    return None


def _as_bool(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().casefold() in {"1", "true", "yes", "on"}
    return bool(value)


def _pair(value: Any) -> tuple[float, float] | None:
    """Validate a Hyprland ``[x, y]`` pair without inventing a fallback."""
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    first, second = _as_float(value[0]), _as_float(value[1])
    if first is None or second is None:
        return None
    return first, second


def stable_id(client: dict[str, Any]) -> str | None:
    """Return the client's foreign-toplevel identifier, if the build exposes one."""
    raw = client.get("raw") if isinstance(client.get("raw"), dict) else client
    for key in _STABLE_ID_KEYS:
        value = raw.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def normalize_client(raw: Any) -> dict[str, Any] | None:
    """Convert one ``hyprctl clients`` entry into the harness window shape."""
    if not isinstance(raw, dict):
        return None
    address = raw.get("address")
    if not isinstance(address, str) or not address.strip():
        return None
    position = _pair(raw.get("at"))
    size = _pair(raw.get("size"))
    workspace = raw.get("workspace") if isinstance(raw.get("workspace"), dict) else {}
    bounds: dict[str, float] | None = None
    if position is not None and size is not None and size[0] > 0 and size[1] > 0:
        bounds = {
            "x": position[0],
            "y": position[1],
            "width": size[0],
            "height": size[1],
        }
    return {
        "address": address.strip(),
        "pid": _as_int(raw.get("pid"), -1),
        "class": str(raw.get("class") or ""),
        "initial_class": str(raw.get("initialClass") or ""),
        "title": str(raw.get("title") or ""),
        "initial_title": str(raw.get("initialTitle") or ""),
        "workspace": {
            "id": _as_int(workspace.get("id")),
            "name": str(workspace.get("name") or ""),
        },
        "monitor": _as_int(raw.get("monitor")),
        "bounds": bounds,
        "floating": _as_bool(raw.get("floating")),
        "fullscreen": _as_int(raw.get("fullscreen"), 0),
        "hidden": _as_bool(raw.get("hidden")),
        "mapped": _as_bool(raw.get("mapped")),
        "xwayland": _as_bool(raw.get("xwayland")),
        "pinned": _as_bool(raw.get("pinned")),
        "focus_history_id": _as_int(raw.get("focusHistoryID")),
        "stable_id": stable_id(raw),
    }


def normalize_layers(raw: Any) -> list[dict[str, Any]]:
    """Flatten ``hyprctl layers -j`` without inventing layer geometry."""
    if not isinstance(raw, dict):
        raise _fail("layers", f"expected an object, got {type(raw).__name__}")
    layers: list[dict[str, Any]] = []
    for output, output_data in raw.items():
        if not isinstance(output_data, dict):
            continue
        levels = output_data.get("levels")
        if not isinstance(levels, dict):
            continue
        for level_name, entries in levels.items():
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, dict):
                    continue
                x = _as_float(entry.get("x"))
                y = _as_float(entry.get("y"))
                width = _as_float(entry.get("w"))
                height = _as_float(entry.get("h"))
                bounds = None
                if (
                    x is not None
                    and y is not None
                    and width is not None
                    and height is not None
                    and width > 0
                    and height > 0
                ):
                    bounds = {
                        "x": x,
                        "y": y,
                        "width": width,
                        "height": height,
                    }
                layers.append(
                    {
                        "output": str(output),
                        "level": _as_int(level_name),
                        "address": str(entry.get("address") or ""),
                        "namespace": str(entry.get("namespace") or ""),
                        "pid": _as_int(entry.get("pid")),
                        "alpha": _as_float(entry.get("alpha")),
                        "bounds": bounds,
                    }
                )
    return layers


class Hyprctl:
    """A validated, bounded ``hyprctl`` client."""

    def __init__(
        self,
        *,
        binary: str = "hyprctl",
        timeout: float = 3.0,
        runner: Any = process.run,
    ) -> None:
        self.binary = binary
        self.timeout = float(timeout)
        self._run = runner
        self._dispatch_api: dict[str, Any] | None = None
        self._encoder: dispatch_grammar.DispatchEncoder | None = None

    # --- plumbing --------------------------------------------------------

    def call(self, args: list[str], *, timeout: float | None = None) -> str:
        result = self._run(
            [self.binary, *args], timeout=self.timeout if timeout is None else timeout
        )
        if not result.ok:
            raise OmaHarnessError(f"hyprctl {' '.join(args)} failed: {result.detail()}")
        return result.stdout

    def json(self, args: list[str], *, timeout: float | None = None) -> Any:
        text = self.call(["-j", *args], timeout=timeout)
        try:
            return json.loads(text)
        except json.JSONDecodeError as exc:
            raise _fail(" ".join(args), f"invalid JSON ({exc})") from exc

    def _json_list(self, args: list[str]) -> list[Any]:
        payload = self.json(args)
        if not isinstance(payload, list):
            raise _fail(" ".join(args), f"expected a list, got {type(payload).__name__}")
        return payload

    def _json_object(self, args: list[str]) -> dict[str, Any]:
        payload = self.json(args)
        if not isinstance(payload, dict):
            raise _fail(
                " ".join(args), f"expected an object, got {type(payload).__name__}"
            )
        return payload

    # --- inspection ------------------------------------------------------

    def clients(self) -> list[dict[str, Any]]:
        windows = [normalize_client(item) for item in self._json_list(["clients"])]
        return [window for window in windows if window is not None]

    def layers(self) -> list[dict[str, Any]]:
        return normalize_layers(self.json(["layers"]))

    def monitors(self) -> list[dict[str, Any]]:
        monitors: list[dict[str, Any]] = []
        for raw in self._json_list(["monitors"]):
            if not isinstance(raw, dict):
                continue
            width = _as_float(raw.get("width"))
            height = _as_float(raw.get("height"))
            active = raw.get("activeWorkspace")
            monitors.append(
                {
                    "id": _as_int(raw.get("id")),
                    "name": str(raw.get("name") or ""),
                    "x": _as_float(raw.get("x")) or 0.0,
                    "y": _as_float(raw.get("y")) or 0.0,
                    "width": width,
                    "height": height,
                    "scale": _as_float(raw.get("scale")) or 1.0,
                    "transform": _as_int(raw.get("transform"), 0),
                    "focused": _as_bool(raw.get("focused")),
                    "active_workspace": (
                        _as_int(active.get("id")) if isinstance(active, dict) else None
                    ),
                }
            )
        return monitors

    def workspaces(self) -> list[dict[str, Any]]:
        workspaces: list[dict[str, Any]] = []
        for raw in self._json_list(["workspaces"]):
            if not isinstance(raw, dict):
                continue
            workspaces.append(
                {
                    "id": _as_int(raw.get("id")),
                    "name": str(raw.get("name") or ""),
                    "monitor": str(raw.get("monitor") or ""),
                    "windows": _as_int(raw.get("windows"), 0),
                }
            )
        return workspaces

    def keyboards(self) -> list[dict[str, Any]]:
        """Report the keyboards and the layout each one is resolving through.

        Only one thing needs this: deciding whether typing text through
        ``ydotool`` would corrupt it. ``ydotool`` sends key positions, and a
        position means different characters under different layouts, so the
        layout is the difference between correct text and silent nonsense.
        """
        raw = self.json(["devices"])
        if not isinstance(raw, dict):
            return []
        keyboards: list[dict[str, Any]] = []
        for item in raw.get("keyboards") or []:
            if not isinstance(item, dict):
                continue
            keyboards.append(
                {
                    "name": str(item.get("name") or ""),
                    "layout": str(item.get("layout") or ""),
                    "variant": str(item.get("variant") or ""),
                    "active_keymap": str(item.get("active_keymap") or ""),
                    "main": _as_bool(item.get("main")),
                }
            )
        return keyboards

    def active_workspace(self) -> dict[str, Any]:
        raw = self._json_object(["activeworkspace"])
        return {
            "id": _as_int(raw.get("id")),
            "name": str(raw.get("name") or ""),
            "monitor": str(raw.get("monitor") or ""),
        }

    def active_window(self) -> dict[str, Any] | None:
        raw = self.json(["activewindow"])
        if not isinstance(raw, dict) or not raw:
            return None
        return normalize_client(raw)

    def cursor_position(self) -> tuple[float, float]:
        raw = self._json_object(["cursorpos"])
        x, y = _as_float(raw.get("x")), _as_float(raw.get("y"))
        if x is None or y is None:
            raise _fail("cursorpos", f"missing coordinates in {raw!r}")
        return x, y

    def version(self) -> dict[str, Any]:
        raw = self._json_object(["version"])
        return {
            "tag": str(raw.get("tag") or ""),
            "commit": str(raw.get("commit") or ""),
            "branch": str(raw.get("branch") or ""),
            "dirty": _as_bool(raw.get("dirty")),
        }

    def build_id(self) -> str:
        """Return the exact compositor build the native extension must match."""
        version = self.version()
        commit = version["commit"] or version["tag"]
        if not commit:
            raise CapabilityError(
                "hyprctl version did not report a commit or tag; the native "
                "extension cannot be pinned to an unidentified compositor build"
            )
        suffix = "-dirty" if version["dirty"] else ""
        return f"{commit[:12]}{suffix}"

    def locked(self) -> bool | None:
        """Return Hyprland's own view of session lock, or ``None`` when unknown.

        Hyprland does not guarantee this query on every build, so ``None`` is a
        first-class answer here. :mod:`omaharness.session` decides what an
        unknown lock state means, and it fails closed.
        """
        try:
            payload = self.json(["locked"], timeout=2.0)
        except OmaHarnessError:
            return None
        if isinstance(payload, dict):
            value = payload.get("locked")
            if isinstance(value, bool):
                return value
            if isinstance(value, str):
                # An unparseable answer is "unknown", never "unlocked".
                text = value.strip().casefold()
                if text in {"1", "true", "yes", "on"}:
                    return True
                if text in {"0", "false", "no", "off"}:
                    return False
            return None
        if isinstance(payload, bool):
            return payload
        return None

    # --- dispatch grammar ------------------------------------------------

    def dispatch_api(self) -> dict[str, Any]:
        """Report which dispatcher grammar this compositor speaks, and why.

        Detected once per session by asking the compositor, then cached. The
        answer carries its own provenance because ``doctor`` prints it: a
        grammar established by probe is a different claim from one guessed
        off a version string.
        """
        if self._dispatch_api is None:
            try:
                version = self.version()
            except OmaHarnessError:
                version = None
            detected = dispatch_grammar.detect(self._probe, version=version)
            detected["dispatchers"] = dispatch_grammar.audit_dispatchers(
                detected["generation"]
            )
            self._dispatch_api = detected
        return dict(self._dispatch_api)

    @property
    def encoder(self) -> dispatch_grammar.DispatchEncoder:
        if self._encoder is None:
            self._encoder = dispatch_grammar.DispatchEncoder(
                self.dispatch_api()["generation"]
            )
        return self._encoder

    def _probe(self, args: list[str]) -> bool:
        """Send the grammar probe, reporting acceptance rather than raising."""
        try:
            self._dispatch(args, timeout=self.timeout)
        except OmaHarnessError:
            return False
        return True

    # --- mutation --------------------------------------------------------

    def _dispatch(self, args: list[str], *, timeout: float | None = None) -> str:
        """Run one encoded dispatch and insist that it actually happened.

        ``hyprctl dispatch`` exits 0 for a dispatcher that ran but declined -
        a vanished window answers ``warning: window not found`` on a
        successful exit - so the exit status alone would let a failed restore
        report success. The reply text is part of the contract here.
        """
        reply = self.call(["dispatch", *args], timeout=timeout).strip()
        head = reply.casefold()
        if head.startswith(("error", "warning", "invalid", "unknown")):
            raise OmaHarnessError(
                f"hyprctl dispatch {' '.join(args)} was rejected: "
                + " ".join(reply.split())[:300]
            )
        return reply

    def dispatch_raw(self, *args: str, timeout: float | None = None) -> str:
        """Escape hatch: send an already-encoded dispatch verbatim.

        Callers are on their own for grammar - with one exception. A selector
        passed positionally under the Lua grammar is refused here rather than
        sent, because that call is accepted, answers ``ok``, and silently
        operates on the focused window. Everything else inside the harness
        goes through the named intents below so that exactly one module knows
        what this compositor's dispatcher syntax looks like.
        """
        arguments = list(args)
        dispatch_grammar.guard_positional_selector(
            self.encoder.generation, arguments
        )
        return self._dispatch(arguments, timeout=timeout)

    def focus_window(self, address: str) -> None:
        self._dispatch(self.encoder.focus_window(address))

    def focus_workspace(self, workspace: int | str) -> None:
        self._dispatch(self.encoder.focus_workspace(workspace))

    def send_shortcut(self, modifiers: str, key: str, address: str) -> None:
        self._dispatch(self.encoder.send_shortcut(modifiers, key, address))

    def move_window_to_workspace(
        self, workspace: int | str, address: str, *, follow: bool = False
    ) -> None:
        self._dispatch(
            self.encoder.move_window_to_workspace(workspace, address, follow=follow)
        )

    def move_workspace_to_monitor(self, workspace: int | str, monitor: str) -> None:
        self._dispatch(self.encoder.move_workspace_to_monitor(workspace, monitor))

    def close_window(self, address: str, *, kill: bool = False) -> None:
        self._dispatch(self.encoder.close_window(address, kill=kill))

    def plugin_dispatch(
        self, name: str, payload: str, *, timeout: float | None = None
    ) -> str:
        return self._dispatch(self.encoder.plugin(name, payload), timeout=timeout)

    def plugin_load(self, path: str) -> str:
        return self.call(["plugin", "load", str(path)], timeout=20.0)

    def plugin_unload(self, path: str) -> str:
        return self.call(["plugin", "unload", str(path)], timeout=20.0)

    def plugin_list(self) -> str:
        return self.call(["plugin", "list"], timeout=10.0)


def in_hyprland_session(environ: dict[str, str] | None = None) -> bool:
    """Return whether this process is inside a live Hyprland Wayland session."""
    env = os.environ if environ is None else environ
    return bool(env.get("HYPRLAND_INSTANCE_SIGNATURE"))


def require_hyprland(environ: dict[str, str] | None = None) -> None:
    """Raise a clear capability error off an Omarchy/Hyprland session."""
    env = os.environ if environ is None else environ
    if not in_hyprland_session(env):
        raise CapabilityError(
            "omaharness controls an Omarchy (Hyprland/Wayland) session. "
            "HYPRLAND_INSTANCE_SIGNATURE is unset, so no compositor is "
            "reachable from this process. Run omaharness inside the graphical "
            "session you want to control."
        )
    if process.which("hyprctl") is None:
        raise CapabilityError(
            "hyprctl is not on PATH. Install it with `sudo pacman -S hyprland`."
        )
