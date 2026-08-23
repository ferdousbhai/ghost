# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/atspi.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See vendor/omaharness/LICENSE for the full text. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""AT-SPI 2 access, guarded exactly like the upstream Apple imports.

Importing :mod:`omaharness` must work anywhere - including a Windows or macOS
development box running the mocked test suite - so ``gi.repository.Atspi`` is
imported behind a guard and every entry point raises
:class:`~omaharness.errors.CapabilityError` when it is missing.

Two Wayland realities shape this module:

* AT-SPI *semantics* (roles, names, actions, editable text, values) are solid.
* AT-SPI *coordinates* are not. Wayland clients generally do not know their
  own on-screen position, so ``getExtents(SCREEN)`` frequently returns
  ``(0, 0)`` or nonsense. The harness therefore prefers window-relative extents
  translated through Hyprland's verified window geometry, tags every rectangle
  with a ``bounds_reliability``, and refuses to guess when nothing is usable.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

from .errors import CapabilityError

try:  # pragma: no cover - import success depends on the host
    import gi

    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi
except (ImportError, ValueError, AttributeError) as exc:  # pragma: no cover
    Atspi = None  # type: ignore[assignment]
    _IMPORT_ERROR: Exception | None = exc
else:  # pragma: no cover
    _IMPORT_ERROR = None

MAX_DEPTH = 25
MAX_NODES = 3000

#: Extents larger than this are compositor noise, not window geometry.
_MAX_EXTENT = 32767.0

#: Normalized bounds provenance, best first.
WINDOW_TRANSLATED = "window-translated"
WINDOW_RELATIVE = "window-relative-only"
SCREEN_REPORTED = "screen-reported"
UNAVAILABLE = "unavailable"

_UNTRUSTED = {SCREEN_REPORTED, WINDOW_RELATIVE, UNAVAILABLE}

#: AT-SPI role names are not one vocabulary. The same widget is a
#: ``"push button"`` under GTK 3 and a ``"button"`` under GTK 4, a
#: ``"page tab"`` under one and a ``"tab"`` under the other. Neither spelling
#: is wrong, so a query for either has to find the same element - matching on
#: raw string equality means an agent's perfectly reasonable role guess
#: silently returns nothing at all.
_ROLE_ALIASES = {
    "push button": "button",
    "pushbutton": "button",
    "page tab": "tab",
    "page tab list": "tab list",
    "check box": "checkbox",
    "combo box": "combobox",
    "entry": "text",
    "text field": "text",
    "text box": "text",
    "textbox": "text",
    "static": "label",
    "list item": "list box item",
}

_ACTION_ALIASES = {
    "press": "click",
    "activate": "click",
    "show menu": "show-menu",
    "showmenu": "show-menu",
}


def canonical_role(role: str) -> str:
    """Fold one role name onto the harness's canonical spelling.

    Case, separators, and the GTK 3 / GTK 4 vocabulary split all collapse
    here, so ``"Push Button"``, ``"push_button"``, and ``"button"`` are one
    role. Anything with no known alias is returned normalized but otherwise
    untouched: this narrows the vocabulary, it never invents roles.
    """
    text = " ".join(str(role).replace("-", " ").replace("_", " ").casefold().split())
    return _ROLE_ALIASES.get(text, text)


def role_matches(wanted: str, actual: str) -> bool:
    """Return whether an element's role answers a query for ``wanted``."""
    return canonical_role(wanted) == canonical_role(actual)


def available() -> bool:
    """Return whether AT-SPI bindings imported on this host."""
    return Atspi is not None


#: Where a distribution package drops PyGObject. Each hit is version-stamped by
#: the ``python3.X`` directory that contains it, which is the whole point: a
#: compiled extension belongs to exactly one minor version.
_SYSTEM_LIB_DIRS = ("/usr/lib", "/usr/lib64", "/usr/local/lib")


def _running_python() -> str:
    return f"{sys.version_info[0]}.{sys.version_info[1]}"


def system_pygobject_versions() -> list[str]:
    """Python minor versions that ship a system PyGObject, newest first."""
    found: set[str] = set()
    for root in _SYSTEM_LIB_DIRS:
        base = Path(root)
        if not base.is_dir():
            continue
        try:
            for entry in base.glob("python3.*/site-packages/gi"):
                found.add(entry.parent.parent.name.removeprefix("python"))
        except OSError:  # pragma: no cover - unreadable /usr is not our problem
            continue

    def key(version: str) -> list[int]:
        return [int(part) for part in version.split(".") if part.isdigit()]

    return sorted(found, key=key, reverse=True)


def binding_diagnosis() -> dict[str, Any]:
    """Explain an unavailable binding in terms of *this* interpreter.

    ``sudo pacman -S python-gobject`` is the right advice exactly once: when
    the package is genuinely absent. Told to a user who already has it - and
    who is simply running the harness on a different Python than the one the
    package was built for - it sends them to reinstall what they have, and the
    import still fails afterwards. A blocker that survives its own remediation
    is worse than no blocker at all, so the cause is established before the
    fix is named.
    """
    running = _running_python()
    if Atspi is not None:
        return {
            "available": True,
            "interpreter": running,
            "reason": None,
            "remediation": [],
        }

    system = system_pygobject_versions()
    isolated = sys.prefix != sys.base_prefix
    report: dict[str, Any] = {
        "available": False,
        "interpreter": running,
        "system_pygobject_for": system,
        "isolated_environment": isolated,
        "import_error": str(_IMPORT_ERROR),
    }

    if not system:
        report["reason"] = "no system PyGObject is installed"
        report["remediation"] = ["sudo pacman -S at-spi2-core python-gobject"]
    elif running not in system:
        newest = system[0]
        report["reason"] = (
            f"PyGObject is installed for Python {', '.join(system)}, but "
            f"omaharness is running on Python {running}; a compiled extension "
            "cannot be imported by a different minor version"
        )
        report["remediation"] = [
            f"rebuild this environment on Python {newest}: "
            f"uv venv --python {newest} --system-site-packages",
            "or compile the bindings into this environment instead: "
            "uv pip install 'omaharness[atspi]'",
        ]
    elif isolated:
        report["reason"] = (
            f"PyGObject is installed for Python {running}, but this "
            "environment does not expose system site-packages"
        )
        report["remediation"] = [
            f"recreate the environment with system packages visible: "
            f"uv venv --python {running} --system-site-packages",
            "or compile the bindings into this environment instead: "
            "uv pip install 'omaharness[atspi]'",
        ]
    else:
        report["reason"] = (
            f"PyGObject is present for Python {running} but did not import "
            f"({_IMPORT_ERROR}); the Atspi typelib is the usual missing piece"
        )
        report["remediation"] = ["sudo pacman -S at-spi2-core"]
    return report


def require_atspi() -> None:
    if Atspi is None:
        diagnosis = binding_diagnosis()
        fixes = "; ".join(diagnosis["remediation"])
        raise CapabilityError(
            f"AT-SPI 2 bindings are unavailable: {diagnosis['reason']}. "
            f"{fixes}. The accessibility bus must also be running for this "
            "session."
        ) from _IMPORT_ERROR


def plausible_extent(extent: Any) -> tuple[float, float, float, float] | None:
    """Validate one AT-SPI rectangle, rejecting the usual Wayland garbage."""
    if extent is None:
        return None
    if isinstance(extent, (tuple, list)) and len(extent) == 4:
        values = list(extent)
    else:
        values = [
            getattr(extent, name, None) for name in ("x", "y", "width", "height")
        ]
    try:
        x, y, width, height = (float(value) for value in values)
    except (TypeError, ValueError):
        return None
    if width <= 0 or height <= 0:
        return None
    if width > _MAX_EXTENT or height > _MAX_EXTENT:
        return None
    if not (-_MAX_EXTENT <= x <= _MAX_EXTENT and -_MAX_EXTENT <= y <= _MAX_EXTENT):
        return None
    return x, y, width, height


def normalize_bounds(
    *,
    window_extent: Any = None,
    screen_extent: Any = None,
    window_bounds: dict[str, float] | None = None,
) -> tuple[dict[str, float] | None, str]:
    """Turn raw AT-SPI extents into screen bounds plus a provenance label."""
    relative = plausible_extent(window_extent)
    if relative is not None:
        x, y, width, height = relative
        if window_bounds:
            return (
                {
                    "x": float(window_bounds["x"]) + x,
                    "y": float(window_bounds["y"]) + y,
                    "width": width,
                    "height": height,
                },
                WINDOW_TRANSLATED,
            )
        return (
            {"x": x, "y": y, "width": width, "height": height},
            WINDOW_RELATIVE,
        )
    absolute = plausible_extent(screen_extent)
    if absolute is not None:
        x, y, width, height = absolute
        return (
            {"x": x, "y": y, "width": width, "height": height},
            SCREEN_REPORTED,
        )
    return None, UNAVAILABLE


def bounds_are_trustworthy(reliability: str) -> bool:
    """Only window-translated rectangles may drive a coordinate decision."""
    return reliability not in _UNTRUSTED


class AtspiBackend:
    """Every AT-SPI call the harness makes, in one mockable surface."""

    def __init__(self, module: Any | None = None) -> None:
        if module is None:
            require_atspi()
            module = Atspi
        self._atspi = module

    # --- discovery -------------------------------------------------------

    def applications(self) -> list[Any]:
        desktop = self._atspi.get_desktop(0)
        count = int(desktop.get_child_count())
        children = []
        for index in range(count):
            child = desktop.get_child_at_index(index)
            if child is not None:
                children.append(child)
        return children

    def application_for_pid(self, pid: int) -> Any | None:
        for application in self.applications():
            if self.pid(application) == int(pid):
                return application
        return None

    def pid(self, node: Any) -> int | None:
        try:
            return int(node.get_process_id())
        except Exception:  # noqa: BLE001 - foreign toolkit, any failure means unknown
            return None

    # --- node properties -------------------------------------------------

    def role(self, node: Any) -> str:
        try:
            return str(node.get_role_name() or "")
        except Exception:  # noqa: BLE001
            return ""

    def name(self, node: Any) -> str:
        try:
            return str(node.get_name() or "")
        except Exception:  # noqa: BLE001
            return ""

    def description(self, node: Any) -> str:
        try:
            return str(node.get_description() or "")
        except Exception:  # noqa: BLE001
            return ""

    def child_count(self, node: Any) -> int:
        try:
            return max(0, int(node.get_child_count()))
        except Exception:  # noqa: BLE001
            return 0

    def child(self, node: Any, index: int) -> Any | None:
        try:
            return node.get_child_at_index(index)
        except Exception:  # noqa: BLE001
            return None

    def states(self, node: Any) -> list[str]:
        try:
            state_set = node.get_state_set()
            states = state_set.get_states()
        except Exception:  # noqa: BLE001
            return []
        names: list[str] = []
        for state in states:
            name = getattr(state, "value_nick", None) or str(state)
            names.append(str(name))
        return names

    def actions(self, node: Any) -> list[str]:
        try:
            count = int(node.get_n_actions())
        except Exception:  # noqa: BLE001
            return []
        names: list[str] = []
        for index in range(count):
            try:
                names.append(str(node.get_action_name(index)))
            except Exception:  # noqa: BLE001, S112 - skip an unreadable action
                continue
        return names

    def do_action(self, node: Any, action: str) -> bool:
        wanted = _ACTION_ALIASES.get(action.casefold(), action)
        names = self.actions(node)
        for index, name in enumerate(names):
            if name.casefold() == wanted.casefold():
                return bool(node.do_action(index))
        raise CapabilityError(
            f"Element exposes no AT-SPI action {action!r}; available: {names}"
        )

    def text(self, node: Any) -> str | None:
        """Read an element's text content, or ``None`` when it has none.

        The read has to go through ``Atspi.Text`` rather than the element.
        ``Atspi.Accessible`` also has a ``get_text``, but it is the *interface
        accessor* - ``get_text(self) -> Atspi.Text`` - so calling it the way
        the AT-SPI Text interface documents, ``get_text(start, end)``, raises
        a TypeError about argument counts. Guarded by ``except``, that made
        every element on the desktop report no text at all, including ones the
        harness had just typed into successfully.
        """
        if not self.implements(node, "text"):
            return None
        try:
            length = int(node.get_character_count())
        except Exception:  # noqa: BLE001
            return None
        try:
            return str(self._read_text(node, 0, length))
        except Exception:  # noqa: BLE001
            return None

    def _read_text(self, node: Any, start: int, end: int) -> Any:
        """Call the Text interface, however these bindings expose it."""
        interface = getattr(self._atspi, "Text", None)
        reader = getattr(interface, "get_text", None)
        if reader is not None:
            return reader(node, start, end)
        # Bindings that put the Text method on the element itself.
        return node.get_text(start, end)

    def is_editable(self, node: Any) -> bool:
        return "editable" in {state.casefold() for state in self.states(node)}

    def insert_text(self, node: Any, value: str, *, replace: bool = False) -> bool:
        """Insert text through EditableText, optionally replacing the content."""
        if not self.is_editable(node):
            raise CapabilityError("Element is not an editable AT-SPI text field")
        if replace:
            try:
                length = int(node.get_character_count())
            except Exception:  # noqa: BLE001
                length = 0
            if length:
                node.delete_text(0, length)
            position = 0
        else:
            try:
                position = int(node.get_caret_offset())
            except Exception:  # noqa: BLE001
                position = int(node.get_character_count() or 0)
        return bool(node.insert_text(position, value, len(value)))

    def interfaces(self, node: Any) -> set[str]:
        """Return the AT-SPI interfaces this element actually implements.

        This is the only trustworthy way to ask what an element supports.
        Several libatspi getters do not raise on an element that lacks the
        interface behind them - they return whatever was on the stack - so
        "call it and catch the exception" silently invents data.
        """
        try:
            names = node.get_interfaces()
        except Exception:  # noqa: BLE001
            return set()
        return {str(name).casefold() for name in names or ()}

    def implements(self, node: Any, interface: str) -> bool:
        return interface.casefold() in self.interfaces(node)

    def value(self, node: Any) -> float | None:
        """Return a slider or spin button's value, or ``None``.

        Gated on the Value interface, and that gate is load-bearing rather
        than defensive. ``get_current_value()`` on an element without Value
        does not raise: it returns uninitialized memory. Measured against
        GTK 4 on Hyprland 0.56, every one of the seven non-Value elements in
        a small window answered ``6.95e-310`` - a denormal read off the
        stack - so an exception-guarded read reported that every button,
        label, and panel on the desktop carried a settable numeric value.
        """
        if not self.implements(node, "value"):
            return None
        try:
            return float(node.get_current_value())
        except Exception:  # noqa: BLE001
            return None

    def set_value(self, node: Any, value: float) -> bool:
        if not self.implements(node, "value"):
            raise CapabilityError(
                "Element does not implement the AT-SPI Value interface, so it "
                "has no numeric value to set"
            )
        try:
            return bool(node.set_current_value(float(value)))
        except Exception as exc:  # noqa: BLE001
            raise CapabilityError(f"Element does not accept a value: {exc}") from exc

    def settable(self, node: Any) -> list[str]:
        names: list[str] = []
        if self.is_editable(node):
            names.append("text")
        if self.implements(node, "value"):
            names.append("value")
        states = {state.casefold() for state in self.states(node)}
        if "focusable" in states:
            names.append("focused")
        return names

    def extents(self, node: Any, *, relative_to_window: bool) -> Any:
        """Read one rectangle, returning ``None`` rather than raising."""
        try:
            coord = (
                self._atspi.CoordType.WINDOW
                if relative_to_window
                else self._atspi.CoordType.SCREEN
            )
        except AttributeError:  # pragma: no cover - very old bindings
            coord = 1 if relative_to_window else 0
        try:
            return node.get_extents(coord)
        except Exception:  # noqa: BLE001
            return None

    def grab_focus(self, node: Any) -> bool:
        try:
            return bool(node.grab_focus())
        except Exception:  # noqa: BLE001
            return False


class AccessibleTree:
    """Bounded, cycle-safe traversal producing normalized nodes."""

    def __init__(
        self,
        backend: AtspiBackend,
        *,
        window_bounds: dict[str, float] | None = None,
    ) -> None:
        self.backend = backend
        self.window_bounds = window_bounds
        self.elements: dict[int, Any] = {}

    def describe(self, node: Any, index: int, depth: int = 0) -> dict[str, Any]:
        backend = self.backend
        bounds, reliability = normalize_bounds(
            window_extent=backend.extents(node, relative_to_window=True),
            screen_extent=backend.extents(node, relative_to_window=False),
            window_bounds=self.window_bounds,
        )
        described: dict[str, Any] = {
            "element_index": index,
            "depth": depth,
            "role": backend.role(node),
            "name": backend.name(node),
            "description": backend.description(node),
            "text": backend.text(node),
            "value": backend.value(node),
            "states": backend.states(node),
            "bounds": bounds,
            "bounds_reliability": reliability,
            "actions": backend.actions(node),
            "settable": backend.settable(node),
        }
        return {
            key: value
            for key, value in described.items()
            if value not in (None, "", [], {}) or key in {"element_index", "depth"}
        }

    def snapshot(
        self,
        root: Any,
        *,
        max_depth: int = MAX_DEPTH,
        max_nodes: int = MAX_NODES,
    ) -> list[dict[str, Any]]:
        """Walk a subtree with hard depth, node, and cycle limits."""
        if max_nodes <= 0 or max_depth < 0:
            raise ValueError("max_nodes must be positive and max_depth non-negative")
        self.elements = {}
        nodes: list[dict[str, Any]] = []
        seen: set[int] = set()

        def visit(node: Any, depth: int) -> None:
            if node is None or depth > max_depth or len(nodes) >= max_nodes:
                return
            identity = id(node)
            path = getattr(node, "get_path", None)
            if callable(path):
                try:
                    identity = hash(("path", str(path())))
                except Exception:  # noqa: BLE001
                    identity = id(node)
            if identity in seen:
                return
            seen.add(identity)

            index = len(nodes)
            self.elements[index] = node
            nodes.append(self.describe(node, index, depth))
            for position in range(self.backend.child_count(node)):
                if len(nodes) >= max_nodes:
                    return
                visit(self.backend.child(node, position), depth + 1)

        visit(root, 0)
        return nodes

    def hit_test(
        self,
        root: Any,
        x: float,
        y: float,
        *,
        max_depth: int = MAX_DEPTH,
        max_nodes: int = MAX_NODES,
    ) -> dict[str, Any]:
        """Return the deepest node whose *trustworthy* bounds contain a point.

        Wayland has no reliable ``getAccessibleAtPoint`` equivalent, so this is
        an explicit best-effort traversal. When no node in the subtree offers
        bounds the harness is willing to trust, it raises rather than returning
        a guess.
        """
        nodes = self.snapshot(root, max_depth=max_depth, max_nodes=max_nodes)
        usable = [
            node
            for node in nodes
            if node.get("bounds")
            and bounds_are_trustworthy(node.get("bounds_reliability", UNAVAILABLE))
        ]
        if not usable:
            raise CapabilityError(
                "No element in this window reported bounds omaharness can trust "
                "(Wayland clients often return zeroed AT-SPI extents). Use "
                "desktop.ax.query() to find the element semantically, or click "
                "screenshot coordinates directly."
            )
        hits = [node for node in usable if _contains(node["bounds"], x, y)]
        if not hits:
            raise CapabilityError(
                f"No element with trustworthy bounds contains ({x:g}, {y:g})"
            )
        return max(hits, key=lambda node: (node["depth"], -_area(node["bounds"])))


def _contains(bounds: dict[str, float], x: float, y: float) -> bool:
    return (
        bounds["x"] <= x < bounds["x"] + bounds["width"]
        and bounds["y"] <= y < bounds["y"] + bounds["height"]
    )


def _area(bounds: dict[str, float]) -> float:
    return float(bounds["width"]) * float(bounds["height"])


def render_tree(nodes: list[dict[str, Any]], *, truncated: bool = False) -> str:
    """Render a snapshot as the indented text an agent reads fastest."""
    lines: list[str] = []
    for node in nodes:
        parts = [str(node["element_index"]), node.get("role") or "unknown"]
        for key in ("name", "description", "text", "value"):
            value = node.get(key)
            if value not in (None, ""):
                parts.append(f'{key}="{_truncate(str(value))}"')
        if node.get("bounds"):
            bounds = node["bounds"]
            parts.append(
                "bounds=({x:g},{y:g},{width:g},{height:g})/{reliability}".format(
                    **bounds, reliability=node.get("bounds_reliability", UNAVAILABLE)
                )
            )
        if node.get("settable"):
            parts.append(f"settable={','.join(node['settable'])}")
        if node.get("actions"):
            parts.append(f"actions={','.join(node['actions'])}")
        lines.append("  " * int(node.get("depth", 0)) + " ".join(parts))
    if truncated:
        lines.append("… tree truncated by max_nodes or max_depth")
    return "\n".join(lines)


def _truncate(value: str, limit: int = 160) -> str:
    value = value.replace("\n", "\\n")
    return value if len(value) <= limit else value[: limit - 1] + "…"
