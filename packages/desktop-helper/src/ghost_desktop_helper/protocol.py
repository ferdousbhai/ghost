"""The line-oriented JSON stdin/stdout protocol.

One request object per line in, one response object per line out, correlated by
``id``. Stderr is logs. The contract is DESKTOP_HELPER.md; this module owns the
transport, the hello handshake, op dispatch, and turning a refusal into a
structured error instead of a crash or - worse - a faked result.

    request:  {"id": <n>, "op": "<name>", "args": { ... }}
    response: {"id": <n>, "ok": true,  "result": { ... }}
              {"id": <n>, "ok": false, "error": {"code","message","details"}}
"""

from __future__ import annotations

import json
import sys
import traceback
from collections.abc import Callable
from typing import Any

from . import __version__, capabilities
from ._vendor.omaharness import hypr
from ._vendor.omaharness.errors import (
    AmbiguousTargetError,
    CapabilityError,
    OmaHarnessError,
    StateRestoreError,
)
from ._vendor.omaharness.inputs import MAX_CLICKS
from .bridge import GhostDesktop, UnknownRefError

# Order matters: _error_code returns the first isinstance match, so the more
# specific OmaHarnessError subclasses (UnknownRefError) precede OmaHarnessError.
_ERROR_CODES: dict[type, str] = {
    CapabilityError: "capability",
    AmbiguousTargetError: "ambiguous_target",
    StateRestoreError: "state_restore",
    UnknownRefError: "unknown_ref",
    OmaHarnessError: "harness",
    ValueError: "invalid_args",
    KeyError: "invalid_args",
    TypeError: "invalid_args",
}


def _error_code(exc: BaseException) -> str:
    for kind, code in _ERROR_CODES.items():
        if isinstance(exc, kind):
            return code
    return "internal"


# Ops that mutate or read enough that a fully-constructed, Hyprland-backed
# GhostDesktop is required; hello/doctor are answered without one.
_HANDLERS: dict[str, Callable[[GhostDesktop, dict[str, Any]], Any]] = {
    "see": lambda d, a: d.see(a.get("name")),
    "state": lambda d, a: d.state(),
    "layers": lambda d, a: d.layers(
        namespace=a.get("namespace"), output=a.get("output")
    ),
    "toplevels": lambda d, a: d.toplevels(timeout=float(a.get("timeout", 1.5))),
    "ax_query": lambda d, a: d.ax_query(
        app=a.get("app"),
        role=a.get("role"),
        text=a.get("text"),
        attributes=a.get("attributes"),
        limit=int(a.get("limit", 20)),
        max_depth=int(a.get("max_depth", 25)),
        max_nodes=int(a.get("max_nodes", 3000)),
    ),
    "ax_roles": lambda d, a: d.ax_roles(app=a.get("app")),
    "ax_perform": lambda d, a: d.ax_perform(
        ref=a["ref"], action=a.get("action", "click")
    ),
    "ax_set": lambda d, a: d.ax_set(
        ref=a["ref"], attribute=a["attribute"], value=a.get("value")
    ),
    "hit_test": lambda d, a: d.hit_test(x=a["x"], y=a["y"], app=a.get("app")),
    "key": lambda d, a: d.key(
        a["chord"], app=a.get("app"), prefer_dispatch=a.get("prefer_dispatch", True)
    ),
    "type": lambda d, a: d.type(
        a["text"],
        app=a.get("app"),
        ref=a.get("ref"),
        prefer_atspi=a.get("prefer_atspi", True),
        replace=a.get("replace", False),
    ),
    "click": lambda d, a: d.click(
        x=a.get("x"),
        y=a.get("y"),
        ref=a.get("ref"),
        app=a.get("app"),
        button=a.get("button", "left"),
        clicks=max(1, min(int(a.get("clicks", 1)), MAX_CLICKS)),
        coordinate_space=a.get("coordinate_space", "screen"),
    ),
    "scroll": lambda d, a: d.scroll(
        delta_y=int(a.get("delta_y", 0)),
        delta_x=int(a.get("delta_x", 0)),
        x=a.get("x"),
        y=a.get("y"),
        app=a.get("app"),
        coordinate_space=a.get("coordinate_space", "screen"),
    ),
    "drag": lambda d, a: d.drag(
        x1=a["x1"],
        y1=a["y1"],
        x2=a["x2"],
        y2=a["y2"],
        app=a.get("app"),
        button=a.get("button", "left"),
        coordinate_space=a.get("coordinate_space", "screen"),
        steps=int(a.get("steps", 16)),
    ),
    "mouse_move": lambda d, a: d.mouse_move(
        x=a["x"],
        y=a["y"],
        app=a.get("app"),
        coordinate_space=a.get("coordinate_space", "screen"),
    ),
    "capture": lambda d, a: d.capture(
        target=a.get("target", "window"),
        name=a.get("name"),
        address=a.get("address"),
        region=a.get("region"),
        output=a.get("output"),
    ),
    "focus": lambda d, a: d.focus(address=a.get("address"), name=a.get("name")),
    "workspace": lambda d, a: d.workspace(
        workspace_id=a.get("id"), name=a.get("name")
    ),
}

OPS = sorted([*_HANDLERS.keys(), "hello", "doctor"])


class Server:
    """Owns stdio, the lazily-built desktop, and the request loop."""

    def __init__(
        self,
        *,
        stdin: Any = None,
        stdout: Any = None,
        stderr: Any = None,
        desktop_factory: Callable[[], GhostDesktop] = GhostDesktop,
    ) -> None:
        self._stdin = stdin if stdin is not None else sys.stdin
        self._stdout = stdout if stdout is not None else sys.stdout
        self._stderr = stderr if stderr is not None else sys.stderr
        self._desktop_factory = desktop_factory
        self._desktop: GhostDesktop | None = None
        self._desktop_error: str | None = None

    # --- desktop lifecycle ----------------------------------------------

    def _get_desktop(self) -> GhostDesktop:
        if self._desktop is None:
            self._desktop = self._desktop_factory()
        return self._desktop

    # --- handshake -------------------------------------------------------

    def hello(self) -> dict[str, Any]:
        """Report version, Hyprland version, dispatch grammar, and backends.

        Built without a full GhostDesktop so it answers honestly even off a
        Hyprland session or with backends missing - degraded, never crashing.
        """
        hyprctl = hypr.Hyprctl()
        payload: dict[str, Any] = {
            "type": "hello",
            "helper": "ghost-desktop-helper",
            "version": __version__,
            "protocol": 1,
            "ops": OPS,
            "in_hyprland_session": hypr.in_hyprland_session(),
        }
        try:
            payload["hyprland-version"] = capabilities.hyprland_version(hyprctl)
        except Exception as exc:  # noqa: BLE001 - handshake never crashes
            payload["hyprland-version"] = None
            payload["hyprland-version-error"] = str(exc)
        try:
            payload["detected-dispatch-grammar"] = capabilities.dispatch_grammar_info(
                hyprctl
            )
        except Exception as exc:  # noqa: BLE001
            payload["detected-dispatch-grammar"] = {"generation": None, "error": str(exc)}
        try:
            payload["available-backends"] = capabilities.detect_backends(hyprctl)
        except Exception as exc:  # noqa: BLE001
            payload["available-backends"] = {"error": str(exc)}
        return payload

    # --- dispatch --------------------------------------------------------

    def handle(self, request: dict[str, Any]) -> dict[str, Any]:
        request_id = request.get("id")
        op = request.get("op")
        args = request.get("args")
        if args is None:
            args = {}
        if not isinstance(args, dict):
            return self._fail(request_id, "invalid_args", "args must be an object")
        try:
            if op == "hello":
                result: Any = self.hello()
            elif op == "doctor":
                result = self.hello()
            elif op in _HANDLERS:
                result = _HANDLERS[op](self._get_desktop(), args)
            else:
                return self._fail(
                    request_id,
                    "unknown_op",
                    f"Unknown op {op!r}; known ops: {', '.join(OPS)}",
                )
        except (KeyboardInterrupt, SystemExit):
            # A shutdown signal is not an op failure: let it unwind the loop
            # instead of swallowing it into a JSON error the caller ignores.
            raise
        except Exception as exc:  # noqa: BLE001 - one bad op never kills the loop
            self._log(f"op {op!r} failed: {exc!r}\n{traceback.format_exc()}")
            details: dict[str, Any] = {}
            if isinstance(exc, StateRestoreError):
                details["state_restore"] = True
            extra = getattr(exc, "details", None)
            if isinstance(extra, dict):
                details.update(extra)
            return self._fail(request_id, _error_code(exc), str(exc), details)
        return {"id": request_id, "ok": True, "result": result}

    @staticmethod
    def _fail(
        request_id: Any, code: str, message: str, details: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        return {
            "id": request_id,
            "ok": False,
            "error": {"code": code, "message": message, "details": details or {}},
        }

    # --- io --------------------------------------------------------------

    def _emit(self, obj: dict[str, Any]) -> None:
        self._stdout.write(json.dumps(obj, default=str) + "\n")
        self._stdout.flush()

    def _log(self, message: str) -> None:
        try:
            self._stderr.write(f"[ghost-desktop-helper] {message}\n")
            self._stderr.flush()
        except Exception:  # noqa: BLE001 - logging must never crash the loop
            pass

    def run(self) -> int:
        """Emit the unsolicited hello, then serve one JSON request per line."""
        self._emit(self.hello())
        for line in self._stdin:
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                self._emit(self._fail(None, "invalid_json", str(exc)))
                continue
            if not isinstance(request, dict):
                self._emit(self._fail(None, "invalid_request", "request must be an object"))
                continue
            self._emit(self.handle(request))
        return 0


def main(argv: list[str] | None = None) -> int:
    return Server().run()
