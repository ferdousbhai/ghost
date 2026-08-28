"""Shared fakes and path bootstrap for the mocked test tier.

Running ``pytest`` straight from the package directory (no install) needs our
``src`` tree on the path. The vendored harness lives below the helper's private
namespace and never receives its own top-level import path.
"""

from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

_ROOT = Path(__file__).resolve().parent.parent
for _p in (_ROOT / "src",):
    if _p.is_dir() and str(_p) not in sys.path:
        sys.path.insert(0, str(_p))


@dataclass
class FakeResult:
    """Mimic the vendored process result enough for the code under test."""

    ok: bool = True
    stdout: str = ""
    stderr: str = ""

    def detail(self) -> str:
        return self.stderr or self.stdout or "failed"


@dataclass
class FakeHyprctl:
    """Provide a dispatch-recording, JSON-free stand-in for vendored Hyprctl."""

    generation: str = "lua-table"
    locked_value: bool | None = False
    _clients: list[dict[str, Any]] = field(default_factory=list)
    dispatched: list[list[str]] = field(default_factory=list)

    def __post_init__(self) -> None:
        from ghost_desktop_helper._vendor.omaharness import dispatch as dispatch_grammar

        self._encoder = dispatch_grammar.DispatchEncoder(self.generation)

    def clients(self) -> list[dict[str, Any]]:
        return [dict(c) for c in self._clients]

    def workspaces(self) -> list[dict[str, Any]]:
        return [{"id": 1, "name": "1", "monitor": "eDP-1", "windows": len(self._clients)}]

    def active_workspace(self) -> dict[str, Any]:
        return {"id": 1, "name": "1", "monitor": "eDP-1"}

    def active_window(self) -> dict[str, Any] | None:
        return self._clients[0] if self._clients else None

    def monitors(self) -> list[dict[str, Any]]:
        return [{"id": 0, "name": "eDP-1", "focused": True, "scale": 1.0,
                 "x": 0.0, "y": 0.0, "width": 1920.0, "height": 1080.0}]

    def layers(self) -> list[dict[str, Any]]:
        return [{"output": "eDP-1", "level": 2, "namespace": "waybar",
                 "address": "0x1", "bounds": {"x": 0, "y": 0, "width": 1920, "height": 40}}]

    def version(self) -> dict[str, Any]:
        return {"tag": "v0.56.2", "commit": "abc", "branch": "main", "dirty": False}

    def locked(self) -> bool | None:
        return self.locked_value

    def cursor_position(self) -> tuple[float, float]:
        return (0.0, 0.0)

    @property
    def encoder(self):  # noqa: ANN201 - fake
        return self._encoder

    def focus_window(self, address: str) -> None:
        self.dispatched.append(self._encoder.focus_window(address))

    def focus_workspace(self, workspace) -> None:  # noqa: ANN001
        self.dispatched.append(self._encoder.focus_workspace(workspace))

    def send_shortcut(self, modifiers: str, key: str, address: str) -> None:
        self.dispatched.append(self._encoder.send_shortcut(modifiers, key, address))

    def dispatch_api(self) -> dict[str, Any]:
        return {"generation": self.generation, "detected_by": "test"}


def unlocked_runner(argv, *, timeout=None, input=None, env=None,  # noqa: A002
                    max_output_bytes=None):
    """A process runner that reports the session unlocked via loginctl."""
    if argv and argv[0] == "loginctl":
        return FakeResult(ok=True, stdout="no")
    return FakeResult(ok=True, stdout="")


def sample_window(**overrides: Any) -> dict[str, Any]:
    window = {
        "address": "0xaaaa",
        "pid": 4242,
        "class": "footclient",
        "initial_class": "footclient",
        "title": "notes",
        "initial_title": "foot",
        "workspace": {"id": 1, "name": "1"},
        "monitor": 0,
        "bounds": {"x": 100.0, "y": 100.0, "width": 800.0, "height": 600.0},
        "floating": False,
        "fullscreen": 0,
        "hidden": False,
        "mapped": True,
        "xwayland": False,
        "pinned": False,
        "focus_history_id": 0,
        "stable_id": "toplevel-1",
    }
    window.update(overrides)
    return window
