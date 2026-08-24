"""The thin Ghost bridge over the vendored omaharness desktop craft.

This is the code that is *ours*: it composes the vendored, proven modules
(dispatch-grammar detection, bounded hyprctl, the disruptive-operation
transaction, the capture ladder, the AT-SPI backend, layout-safe input) into
the fourteen desktop ops that DESKTOP_HELPER.md defines. Everything hard is
vendored; everything here is glue and honesty-metadata shaping.

Two rules the harness taught us, kept intact:

* Refuse, never fake. A missing backend or an unreadable value raises a
  CapabilityError with the remediation, and the protocol layer turns that into
  a structured error - the ghost never receives a blank screenshot or an empty
  tree dressed up as success.
* Every mutating op fails closed on a locked (or unknown) session, and every
  capture/input/perform result carries {backend, background_safe, interference,
  warnings} so the model knows whether the desktop was disturbed.
"""

from __future__ import annotations

import base64
import tempfile
import time
from pathlib import Path
from typing import Any

from omaharness import atspi as atspi_module
from omaharness import hypr, process, session
from omaharness import toplevels as toplevel_protocol
from omaharness.capture import CaptureRouter, png_size, region_argument
from omaharness.errors import (
    AmbiguousTargetError,
    CapabilityError,
    OmaHarnessError,
)
from omaharness.headless import HeadlessCapture
from omaharness.inputs import Wtype, Ydotool
from omaharness.keys import hypr_shortcut
from omaharness.transaction import CompositorTransaction

_SKELETAL_TREE = 3
_CHROMIUM_HINTS = ("chrom", "electron", "code", "slack", "discord", "spotify")

# Server-side ceilings for the model-supplied AT-SPI walk knobs. A recursive
# D-Bus tree walk is strictly serial on the single request line, so an
# unbounded max_nodes wedges every subsequent desktop op behind it. These caps
# turn a hostile or careless argument into a bounded walk; they are documented
# in DESKTOP_HELPER.md.
_MAX_NODES_CAP = 5000
_MAX_DEPTH_CAP = 40
_MAX_LIMIT_CAP = 200
_MAX_TIMEOUT_CAP = 5.0
#: Wall-clock budget for a single snapshot walk, independent of node/depth caps:
#: a small tree of pathologically slow nodes must still terminate.
_SNAPSHOT_BUDGET_S = 5.0
#: Default interpolated waypoints for a drag, endpoints included. A canvas or
#: drag-and-drop target needs the intermediate pointer-motion events, not just a
#: teleport from start to end, or it registers nothing between the two.
_DRAG_STEPS = 16
#: Ceiling on drag waypoints, so a hostile ``steps`` cannot wedge the single
#: request line under an arbitrarily long sequence of ydotool moves.
_MAX_DRAG_STEPS = 200
#: The warning both mouse_move branches append: unlike click/drag, the pointer is
#: deliberately left where it moved, so the honesty metadata says so.
_HOVER_WARNING = (
    "the pointer was left where it moved (a hover); the next input op, or the "
    "user, will move it from here"
)


class UnknownRefError(OmaHarnessError):
    """An element ref does not address the current accessibility snapshot.

    Mirrors the browser relay's ``unknown_ref`` failure (see
    ``packages/extensions`` ``browser-session.ts``): a ref no snapshot minted, a
    ref a newer snapshot has since invalidated (stale epoch), or one whose index
    is out of range. The protocol layer maps this to the ``unknown_ref`` error
    code and forwards ``details`` so the model can tell a stale ref from a
    never-minted one and re-run ``ax_query``.
    """

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message)
        self.details = details


class _BudgetedTree(atspi_module.AccessibleTree):
    """An AccessibleTree that aborts its walk past a wall-clock deadline.

    The vendored ``snapshot`` bounds itself by node count and depth but not by
    time; a slow-per-node D-Bus tree can still run for minutes. This subclass
    layers a monotonic deadline over the unmodified vendored walk by checking it
    once per node in ``describe``, which is where the per-node D-Bus reads
    happen.
    """

    def __init__(
        self,
        backend: Any,
        *,
        window_bounds: dict[str, float] | None = None,
        budget_s: float | None = _SNAPSHOT_BUDGET_S,
        clock: Any = time.monotonic,
    ) -> None:
        super().__init__(backend, window_bounds=window_bounds)
        self._budget_s = budget_s
        self._clock = clock
        self._deadline: float | None = None

    def snapshot(self, root: Any, **kwargs: Any) -> list[dict[str, Any]]:
        self._deadline = (
            None if self._budget_s is None else self._clock() + self._budget_s
        )
        return super().snapshot(root, **kwargs)

    def describe(self, node: Any, index: int, depth: int = 0) -> dict[str, Any]:
        # index 0 is the root: always describe at least it, so a query never
        # fails before doing any work.
        if (
            self._deadline is not None
            and index > 0
            and self._clock() > self._deadline
        ):
            raise CapabilityError(
                f"AT-SPI snapshot exceeded its {self._budget_s:g}s wall-clock "
                f"budget after {index} nodes; narrow the walk with a smaller "
                "max_nodes/max_depth or target a specific app"
            )
        return super().describe(node, index, depth)


def _honesty(
    backend: str,
    *,
    background_safe: bool,
    interference: list[str] | None = None,
    warnings: list[str] | None = None,
    **extra: Any,
) -> dict[str, Any]:
    """Shape the four honesty fields every capture/input/perform op returns."""
    return {
        "backend": backend,
        "background_safe": bool(background_safe),
        "interference": list(interference or []),
        "warnings": list(warnings or []),
        **extra,
    }


class _NoCursorRestoreTransaction(CompositorTransaction):
    """A transaction that leaves the physical pointer where the op put it.

    Every other guardrail is inherited unchanged - the single-writer lock, the
    fail-closed session check, and focus/workspace restore. Only cursor restore
    is dropped, because ``mouse_move`` exists precisely to park the pointer (a
    hover). Restoring it on exit would snap it straight back and undo the one
    thing the op does, so a persistent move needs a transaction that does not
    pull the cursor home. The vendored ``CompositorTransaction`` is subclassed
    rather than edited, the same way ``_BudgetedTree`` layers a deadline over
    the vendored ``AccessibleTree``.
    """

    def _restore_cursor(self) -> list[str]:
        return []


class GhostDesktop:
    """Desktop observation and control for one persistent helper process."""

    def __init__(
        self,
        *,
        hyprctl: Any = None,
        ydotool: Any = None,
        wtype: Any = None,
        atspi_backend: Any = None,
        capture_router: Any = None,
        headless: Any = None,
        runner: Any = process.run,
        allow_headless_capture: bool = True,
        toplevel_lister: Any = None,
    ) -> None:
        if hyprctl is None:
            hypr.require_hyprland()
            hyprctl = hypr.Hyprctl(runner=runner)
        self.hyprctl = hyprctl
        self.ydotool = (
            Ydotool(runner=runner, position_reader=self.hyprctl.cursor_position)
            if ydotool is None
            else ydotool
        )
        self.wtype = Wtype(runner=runner) if wtype is None else wtype
        self._runner = runner
        self._atspi = atspi_backend
        self.capture_router = (
            CaptureRouter(self.hyprctl, self.ydotool, runner=runner)
            if capture_router is None
            else capture_router
        )
        self.headless = (
            HeadlessCapture(self.hyprctl, runner=runner)
            if headless is None
            else headless
        )
        self.allow_headless_capture = bool(allow_headless_capture)
        self._toplevel_lister = (
            toplevel_protocol.list_toplevels
            if toplevel_lister is None
            else toplevel_lister
        )
        self._last_window: dict[str, Any] | None = None
        # The accessibility ref table the model addresses, plus the epoch and
        # owning window it belongs to. Every new public snapshot bumps the epoch
        # so refs minted against an older snapshot (or a different app) are
        # detectably stale rather than silently redirected to a live index.
        self._ax_elements: dict[int, Any] = {}
        self._ax_epoch: int = 0
        self._ax_window: dict[str, Any] | None = None

    # --- target resolution (ported from omaharness.desktop) --------------

    def _match_windows(self, query: str | int | None) -> list[dict[str, Any]]:
        clients = self.hyprctl.clients()
        if query is None:
            if self._last_window is None:
                raise OmaHarnessError(
                    "Specify a window by class, title, PID, or Hyprland address"
                )
            query = self._last_window["address"]
        needle = str(query).strip()
        folded = needle.casefold()

        if needle.isdigit():
            pid = [c for c in clients if c["pid"] == int(needle)]
            if pid:
                return pid
        address = [c for c in clients if c["address"].casefold() == folded]
        if address:
            return address
        stable = [
            c
            for c in clients
            if c.get("stable_id") and str(c["stable_id"]).casefold() == folded
        ]
        if stable:
            return stable
        fields = ("class", "initial_class", "title", "initial_title")
        exact = [
            c
            for c in clients
            if folded in {str(c[f]).casefold() for f in fields if c[f]}
        ]
        if exact:
            return exact
        partial = [
            c
            for c in clients
            if any(folded in str(c[f]).casefold() for f in fields if c[f])
        ]
        if not partial:
            raise OmaHarnessError(f"No open window matches {str(query)!r}")
        identities = {(c["pid"], c["class"]) for c in partial}
        if len(identities) > 1:
            listed = ", ".join(
                f"{c['class']}:{c['title']} ({c['pid']})" for c in partial[:8]
            )
            raise AmbiguousTargetError(
                f"Window query {str(query)!r} is ambiguous: {listed}"
            )
        return partial

    def _resolve_window(self, query: str | int | None = None) -> dict[str, Any]:
        matches = self._match_windows(query)
        matches.sort(key=self._window_rank)
        window = matches[0]
        self._last_window = window
        return window

    @staticmethod
    def _window_rank(window: dict[str, Any]) -> tuple[Any, ...]:
        bounds = window.get("bounds") or {}
        area = float(bounds.get("width", 0)) * float(bounds.get("height", 0))
        history = window.get("focus_history_id")
        return (
            window.get("hidden", False) or not window.get("mapped", True),
            -area,
            history if isinstance(history, int) and history >= 0 else 1_000_000,
            window["address"],
        )

    def _require_input_allowed(self, operation: str) -> None:
        session.require_unlocked(
            self.hyprctl, operation=operation, runner=self._runner
        )

    def _transaction(self, operation: str) -> CompositorTransaction:
        return CompositorTransaction(
            self.hyprctl, self.ydotool, operation=operation, runner=self._runner
        )

    # --- AT-SPI plumbing -------------------------------------------------

    def _ax_backend(self) -> atspi_module.AtspiBackend:
        if self._atspi is None:
            self._atspi = atspi_module.AtspiBackend()
        return self._atspi

    def _ax_root(self, window: dict[str, Any]) -> Any:
        backend = self._ax_backend()
        application = backend.application_for_pid(int(window["pid"]))
        if application is None:
            raise CapabilityError(
                f"No AT-SPI application is registered for PID {window['pid']} "
                f"({window.get('class')}). Chromium and Electron expose their "
                "tree only when accessibility is enabled: relaunch that app with "
                "--force-renderer-accessibility=complete, or use capture + vision."
            )
        return application

    def _ax_tree(self, window: dict[str, Any]) -> _BudgetedTree:
        return _BudgetedTree(
            self._ax_backend(),
            window_bounds=window.get("bounds"),
            budget_s=_SNAPSHOT_BUDGET_S,
        )

    def _publish_snapshot(self, tree: Any, window: dict[str, Any]) -> int:
        """Install ``tree`` as the ref table the model addresses; return its epoch.

        Each call increments the epoch, so every ref minted before it - from an
        earlier query, or a snapshot of a different app - is now detectably
        stale. The owning window travels with the table so a ref carries its
        window without leaning on the mutable ``_last_window``.
        """
        self._ax_epoch += 1
        self._ax_elements = dict(tree.elements)
        self._ax_window = window
        return self._ax_epoch

    def _mint_ref(self, epoch: int, element_index: int) -> str:
        return f"{epoch}:{element_index}"

    @staticmethod
    def _parse_ref(ref: Any) -> tuple[int, int]:
        epoch_text, sep, index_text = str(ref).strip().partition(":")
        if not sep:
            raise UnknownRefError(
                f"Element ref {ref!r} is not a snapshot-qualified ref; run "
                "ax_query or ax_roles to mint a fresh 'epoch:index' ref",
                ref=ref,
                reason="malformed",
            )
        try:
            return int(epoch_text), int(index_text)
        except ValueError as exc:
            raise UnknownRefError(
                f"Element ref {ref!r} is malformed; expected 'epoch:index' as "
                "minted by ax_query",
                ref=ref,
                reason="malformed",
            ) from exc

    def _ax_element(self, ref: Any) -> Any:
        epoch, index = self._parse_ref(ref)
        if not self._ax_elements or epoch != self._ax_epoch:
            raise UnknownRefError(
                f"Element ref {ref!r} is stale: it addresses accessibility "
                f"snapshot #{epoch}, but the current snapshot is "
                f"#{self._ax_epoch}. A newer ax_query/ax_roles - or a query of a "
                "different app - replaced the tree; re-run ax_query and use the "
                "refs it returns.",
                ref=ref,
                reason="stale",
                snapshot=epoch,
                current_snapshot=self._ax_epoch,
            )
        try:
            return self._ax_elements[index]
        except (KeyError, TypeError) as exc:
            raise UnknownRefError(
                f"Element ref {ref!r} is out of range for snapshot "
                f"#{self._ax_epoch} ({len(self._ax_elements)} elements); re-run "
                "ax_query",
                ref=ref,
                reason="out_of_range",
            ) from exc

    # --- server-side clamps for model-supplied walk knobs ----------------

    @staticmethod
    def _clamp_nodes(value: Any) -> int:
        return max(1, min(int(value), _MAX_NODES_CAP))

    @staticmethod
    def _clamp_depth(value: Any) -> int:
        return max(0, min(int(value), _MAX_DEPTH_CAP))

    @staticmethod
    def _clamp_timeout(value: Any, *, default: float = 1.5) -> float:
        try:
            seconds = float(value)
        except (TypeError, ValueError):
            seconds = default
        return min(max(0.0, seconds), _MAX_TIMEOUT_CAP)

    @staticmethod
    def _effective_limit(limit: Any) -> int:
        """Resolve a match limit to a positive cap.

        ``limit <= 0`` is documented to mean "as many as the ceiling allows"
        rather than "unlimited", so a query can never bypass the cap by asking
        for zero or a negative count.
        """
        limit = int(limit)
        return _MAX_LIMIT_CAP if limit <= 0 else min(limit, _MAX_LIMIT_CAP)

    # --- ops: windows / desktop state ------------------------------------

    def see(self, name: str | None = None) -> dict[str, Any]:
        """Windows matching a name (or all), best candidate first."""
        matches = (
            self.hyprctl.clients() if name is None else self._match_windows(name)
        )
        matches.sort(key=self._window_rank)
        if matches:
            self._last_window = matches[0]
        active = self.hyprctl.active_window()
        active_address = active["address"] if active else None
        windows = [
            {
                "address": w["address"],
                "title": w["title"],
                "class": w["class"],
                "pid": w["pid"],
                "workspace": w["workspace"],
                "geometry": w.get("bounds"),
                "focused": w["address"] == active_address,
                "hidden": w.get("hidden", False),
                "xwayland": w.get("xwayland", False),
                "stable_id": w.get("stable_id"),
            }
            for w in matches
        ]
        return {"windows": windows, "count": len(windows)}

    def state(self) -> dict[str, Any]:
        """Condensed clients + workspaces + activewindow, sourced here."""
        return {
            "clients": self.hyprctl.clients(),
            "workspaces": self.hyprctl.workspaces(),
            "activeworkspace": self.hyprctl.active_workspace(),
            "activewindow": self.hyprctl.active_window(),
            "monitors": self.hyprctl.monitors(),
        }

    def layers(
        self, *, namespace: str | None = None, output: str | None = None
    ) -> dict[str, Any]:
        layers = self.hyprctl.layers()
        if namespace is not None:
            layers = [item for item in layers if item["namespace"] == namespace]
        if output is not None:
            layers = [item for item in layers if item["output"] == output]
        return {"layers": layers, "count": len(layers)}

    def toplevels(self, *, timeout: float = 1.5) -> dict[str, Any]:
        """ext-foreign-toplevel-list-v1 list reconciled with hyprctl clients."""
        timeout = self._clamp_timeout(timeout)
        listing = self._toplevel_lister(timeout=timeout)
        report = listing.as_dict()
        try:
            windows = self.hyprctl.clients()
        except OmaHarnessError as exc:
            report["compositor_windows"] = None
            report["error"] = report.get("error") or str(exc)
            return report
        exported = listing.identifiers
        report["compositor_windows"] = len(windows)
        report["background_capturable"] = [
            {
                "address": w["address"],
                "class": w["class"],
                "identifier": w.get("stable_id"),
                "exported": bool(
                    w.get("stable_id") and w["stable_id"] in exported
                ),
            }
            for w in windows
        ]
        return report

    # --- ops: accessibility ----------------------------------------------

    def ax_query(
        self,
        *,
        app: str | int | None = None,
        role: str | None = None,
        text: str | None = None,
        attributes: Any = None,
        limit: int = 20,
        max_depth: int = 25,
        max_nodes: int = 3000,
    ) -> dict[str, Any]:
        max_depth = self._clamp_depth(max_depth)
        max_nodes = self._clamp_nodes(max_nodes)
        effective_limit = self._effective_limit(limit)
        window = self._resolve_window(app)
        tree = self._ax_tree(window)
        nodes = tree.snapshot(
            self._ax_root(window), max_depth=max_depth, max_nodes=max_nodes
        )
        epoch = self._publish_snapshot(tree, window)
        needle = text.casefold() if text is not None else None
        wanted_states = {s.casefold() for s in self._as_state_list(attributes)}
        matches: list[dict[str, Any]] = []
        for node in nodes:
            if role is not None and not atspi_module.role_matches(
                role, node.get("role", "")
            ):
                continue
            if wanted_states and not wanted_states.issubset(
                {s.casefold() for s in node.get("states", [])}
            ):
                continue
            if needle is not None and not any(
                needle in str(node.get(f, "")).casefold()
                for f in ("name", "description", "text", "value")
            ):
                continue
            matches.append(
                {**node, "ref": self._mint_ref(epoch, node["element_index"])}
            )
            if len(matches) >= effective_limit:
                break
        warnings = self._tree_warnings(window, nodes)
        # A zero-match role is a normal read result, not a capability failure:
        # returning empty with the roles that *are* present gives the model the
        # better recovery signal (what to query instead) in one round-trip, and
        # matches how a zero-match text filter already behaves.
        if role is not None and not matches:
            warnings = [*warnings, self._role_absent_warning(role, nodes)]
        return {
            "app": window["class"] or window["initial_class"],
            "pid": window["pid"],
            "elements": matches,
            "count": len(matches),
            "truncated": len(nodes) >= max_nodes,
            "warnings": warnings,
        }

    @staticmethod
    def _as_state_list(attributes: Any) -> list[str]:
        if attributes is None:
            return []
        if isinstance(attributes, str):
            return [attributes]
        if isinstance(attributes, dict):
            # {"states": [...]} or {state: True}
            if "states" in attributes:
                return list(attributes["states"])
            return [k for k, v in attributes.items() if v]
        if isinstance(attributes, (list, tuple)):
            return list(attributes)
        return []

    @staticmethod
    def _roles_present(nodes: list[dict[str, Any]]) -> list[str]:
        present = {atspi_module.canonical_role(n.get("role", "")) for n in nodes}
        present.discard("")
        return sorted(present)

    def _role_absent_warning(
        self, role: str, nodes: list[dict[str, Any]]
    ) -> str:
        present = self._roles_present(nodes)
        return (
            f"No element in this tree has the role {role!r}. Roles present "
            f"here: {', '.join(present) or '(none)'}"
        )

    def ax_roles(
        self,
        *,
        app: str | int | None = None,
        max_depth: int = 25,
        max_nodes: int = 3000,
    ) -> dict[str, Any]:
        max_depth = self._clamp_depth(max_depth)
        max_nodes = self._clamp_nodes(max_nodes)
        window = self._resolve_window(app)
        tree = self._ax_tree(window)
        nodes = tree.snapshot(
            self._ax_root(window), max_depth=max_depth, max_nodes=max_nodes
        )
        self._publish_snapshot(tree, window)
        counts: dict[str, int] = {}
        for node in nodes:
            name = atspi_module.canonical_role(node.get("role", ""))
            if name:
                counts[name] = counts.get(name, 0) + 1
        ordered = dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0])))
        return {
            "app": window["class"] or window["initial_class"],
            "pid": window["pid"],
            "roles": ordered,
        }

    def ax_perform(self, *, ref: Any, action: str = "click") -> dict[str, Any]:
        node = self._ax_element(ref)
        self._require_input_allowed(f"ax_perform({action!r})")
        self._ax_backend().do_action(node, action)
        # A semantic action can move focus exactly as a click would, but the
        # AT-SPI action itself does not switch workspace or pointer; treat it as
        # background-safe unless it is a focus grab (handled in ax_set).
        return _honesty("atspi", background_safe=True, ref=ref, action=action)

    def ax_set(self, *, ref: Any, attribute: str, value: Any) -> dict[str, Any]:
        node = self._ax_element(ref)
        backend = self._ax_backend()
        self._require_input_allowed(f"ax_set({attribute!r})")
        if attribute == "text":
            backend.insert_text(node, str(value), replace=True)
            return _honesty("atspi", background_safe=True, ref=ref, attribute=attribute)
        if attribute == "value":
            backend.set_value(node, float(value))
            return _honesty("atspi", background_safe=True, ref=ref, attribute=attribute)
        if attribute == "focused":
            if not value:
                raise OmaHarnessError("AT-SPI can request focus but cannot remove it")
            if not backend.grab_focus(node):
                raise CapabilityError("Element refused an AT-SPI focus grab")
            return _honesty(
                "atspi",
                background_safe=False,
                interference=["focus-change"],
                ref=ref,
                attribute=attribute,
            )
        raise OmaHarnessError(
            f"Cannot set {attribute!r}; settable AT-SPI attributes are "
            "'text', 'value', and 'focused'"
        )

    def hit_test(
        self,
        *,
        x: float,
        y: float,
        app: str | int | None = None,
        max_depth: int = 25,
        max_nodes: int = 3000,
    ) -> dict[str, Any]:
        """Resolve a screen coordinate to the AT-SPI element under it.

        This closes the screenshot -> coordinate -> semantic-ref loop: a vision
        pass names a pixel, hit_test turns that pixel into a live element ``ref``
        the model can then drive with ax_perform / ax_set / click / type. The
        returned ref is minted against a freshly published snapshot, so it is
        current exactly like a ref from ax_query, and stale the moment a later
        snapshot bumps the epoch. Coordinates are screen-space (the space the
        element bounds normalise to); the vendored walk refuses rather than
        guesses when no node offers bounds it can trust.
        """
        max_depth = self._clamp_depth(max_depth)
        max_nodes = self._clamp_nodes(max_nodes)
        window = self._resolve_window(app)
        tree = self._ax_tree(window)
        node = tree.hit_test(
            self._ax_root(window),
            float(x),
            float(y),
            max_depth=max_depth,
            max_nodes=max_nodes,
        )
        epoch = self._publish_snapshot(tree, window)
        return {
            "app": window["class"] or window["initial_class"],
            "pid": window["pid"],
            "element": {**node, "ref": self._mint_ref(epoch, node["element_index"])},
        }

    # --- ops: input ------------------------------------------------------

    def key(
        self,
        chord: str,
        *,
        app: str | int | None = None,
        prefer_dispatch: bool = True,
    ) -> dict[str, Any]:
        window = self._resolve_window(app)
        self._require_input_allowed(f"key {chord!r}")
        shortcut = hypr_shortcut(chord) if prefer_dispatch else None
        if shortcut is not None:
            modifiers, keysym = shortcut
            self.hyprctl.send_shortcut(modifiers, keysym, window["address"])
            return _honesty(
                "hyprland-sendshortcut",
                background_safe=True,
                target=window["address"],
                key=chord,
            )
        reason = (
            f"{chord!r} has no XKB spelling for sendshortcut"
            if prefer_dispatch
            else f"prefer_dispatch=False requested a real key event for {chord!r}"
        )
        try:
            self.ydotool.require()
        except CapabilityError as exc:
            raise CapabilityError(
                f"{exc} The compositor's own dispatch path was not used either, "
                f"because {reason}."
            ) from exc
        transaction = self._transaction(f"key {chord!r}")
        with transaction:
            transaction.focus_target(window)
            self.ydotool.key(chord)
        report = transaction.report()
        return _honesty(
            "ydotool",
            background_safe=report["background_safe"],
            interference=report["interference"],
            warnings=[
                *report["warnings"],
                f"{reason}, so it was injected into the focused window",
            ],
            target=window["address"],
            key=chord,
        )

    def type(
        self,
        text: str,
        *,
        app: str | int | None = None,
        ref: Any = None,
        prefer_atspi: bool = True,
        replace: bool = False,
    ) -> dict[str, Any]:
        window = self._resolve_window(app)
        self._require_input_allowed("typing")
        warnings: list[str] = []
        if prefer_atspi:
            node = None
            if ref is not None:
                node = self._ax_element(ref)
            else:
                node = self._focused_editable(window, warnings)
            if node is not None:
                self._ax_backend().insert_text(node, text, replace=replace)
                return _honesty(
                    "atspi",
                    background_safe=True,
                    warnings=warnings,
                    target=window["address"],
                    characters=len(text),
                )
        if not self.wtype.available():
            raise CapabilityError(
                "wtype is not installed, and it is what types text without a "
                "keyboard-layout dependency. Install it with `sudo pacman -S "
                "wtype`."
                + (" The AT-SPI path was not available either." if warnings else "")
            )
        transaction = self._transaction("typing")
        with transaction:
            transaction.focus_target(window)
            self.wtype.type(text)
        report = transaction.report()
        return _honesty(
            "wtype",
            background_safe=report["background_safe"],
            interference=report["interference"],
            warnings=warnings + report["warnings"],
            target=window["address"],
            characters=len(text),
        )

    def _focused_editable(
        self, window: dict[str, Any], warnings: list[str]
    ) -> Any | None:
        """Best-effort: find the focused editable text node in the window tree."""
        try:
            tree = self._ax_tree(window)
            root = self._ax_root(window)
        except CapabilityError as exc:
            warnings.append(str(exc))
            return None
        # This is a PRIVATE snapshot: it resolves the focused field for one
        # type() call and must NOT replace the ref table the model is
        # addressing, or a bare type() between a query and a perform would
        # silently invalidate (and renumber) the model's refs. It reads from
        # this local tree only and leaves _ax_elements / _ax_epoch untouched.
        nodes = tree.snapshot(root)
        for index, node in enumerate(nodes):
            states = {s.casefold() for s in node.get("states", [])}
            if "editable" in states and {"focused", "active"} & states:
                return tree.elements.get(index)
        # Fall back to any single editable field.
        editable = [
            index
            for index, node in enumerate(nodes)
            if "editable" in {s.casefold() for s in node.get("states", [])}
        ]
        if len(editable) == 1:
            return tree.elements.get(editable[0])
        if not editable:
            warnings.append("no editable AT-SPI text field found in the focused window")
        else:
            warnings.append(
                "several editable fields found; specify a ref to disambiguate"
            )
        return None

    def click(
        self,
        *,
        x: float | None = None,
        y: float | None = None,
        ref: Any = None,
        app: str | int | None = None,
        button: str = "left",
        clicks: int = 1,
        coordinate_space: str = "screen",
    ) -> dict[str, Any]:
        if ref is not None:
            return self._click_ref(ref, button=button, clicks=clicks)
        if x is None or y is None:
            raise OmaHarnessError("click needs either {x, y} or {ref}")
        window = self._resolve_window(app)
        self._require_input_allowed("click")
        point = self._screen_point(float(x), float(y), coordinate_space, window)
        self.ydotool.require()
        transaction = self._transaction("click")
        with transaction:
            focused = transaction.focus_target(window)
            transaction.move_pointer(*self._reproject(point, window, focused))
            self.ydotool.click(button, clicks=max(1, int(clicks)))
        report = transaction.report()
        return _honesty(
            "ydotool",
            background_safe=report["background_safe"],
            interference=report["interference"],
            warnings=report["warnings"],
            target=window["address"],
            button=button,
            clicks=max(1, int(clicks)),
        )

    def _click_ref(self, ref: Any, *, button: str, clicks: int) -> dict[str, Any]:
        node = self._ax_element(ref)
        # The ref carries the window it was snapshotted in; _ax_element already
        # proved the ref is current, so this window is the one that owns it -
        # never the mutable _last_window, which a later resolve may have moved.
        window = self._ax_window
        if window is None:
            raise OmaHarnessError(
                f"Element ref {ref!r} has no associated window; run ax_query "
                "first to take a fresh accessibility snapshot"
            )
        backend = self._ax_backend()
        bounds, reliability = atspi_module.normalize_bounds(
            window_extent=backend.extents(node, relative_to_window=True),
            screen_extent=backend.extents(node, relative_to_window=False),
            window_bounds=window.get("bounds"),
        )
        if not bounds or not atspi_module.bounds_are_trustworthy(reliability):
            raise CapabilityError(
                f"Element ref {ref!r} has no trustworthy on-screen bounds "
                f"(reliability={reliability}); use ax_perform to click it "
                "semantically, or capture + coordinate click."
            )
        center_x = float(bounds["x"]) + float(bounds["width"]) / 2
        center_y = float(bounds["y"]) + float(bounds["height"]) / 2
        self._require_input_allowed("click")
        self.ydotool.require()
        transaction = self._transaction("click")
        with transaction:
            focused = transaction.focus_target(window)
            transaction.move_pointer(
                *self._reproject((center_x, center_y), window, focused)
            )
            self.ydotool.click(button, clicks=max(1, int(clicks)))
        report = transaction.report()
        return _honesty(
            "ydotool",
            background_safe=report["background_safe"],
            interference=report["interference"],
            warnings=report["warnings"],
            ref=ref,
            button=button,
            clicks=max(1, int(clicks)),
        )

    def _screen_point(
        self,
        x: float,
        y: float,
        coordinate_space: str,
        window: dict[str, Any],
    ) -> tuple[float, float]:
        if coordinate_space == "screen":
            return x, y
        if coordinate_space == "window":
            bounds = window.get("bounds")
            if not bounds:
                raise CapabilityError(
                    f"Hyprland reported no geometry for {window['address']}, so a "
                    "window-local coordinate cannot be resolved"
                )
            return float(bounds["x"]) + x, float(bounds["y"]) + y
        raise OmaHarnessError(
            "coordinate_space must be 'screen' or 'window' (screenshot scaling "
            "is applied by the ghost_screen extension before it calls click)"
        )

    @staticmethod
    def _reproject(
        point: tuple[float, float],
        original: dict[str, Any],
        focused: dict[str, Any],
    ) -> tuple[float, float]:
        """Re-anchor a window-relative point after focus may have moved it."""
        o_bounds = original.get("bounds")
        f_bounds = focused.get("bounds")
        if not o_bounds or not f_bounds:
            return point
        rel_x = point[0] - float(o_bounds["x"])
        rel_y = point[1] - float(o_bounds["y"])
        return float(f_bounds["x"]) + rel_x, float(f_bounds["y"]) + rel_y

    @staticmethod
    def _interpolate(
        start: tuple[float, float], end: tuple[float, float], steps: int
    ) -> list[tuple[float, float]]:
        """Waypoints from ``start`` to ``end``, endpoints included."""
        steps = max(1, min(int(steps), _MAX_DRAG_STEPS))
        (x1, y1), (x2, y2) = start, end
        return [
            (x1 + (x2 - x1) * (i / steps), y1 + (y2 - y1) * (i / steps))
            for i in range(steps + 1)
        ]

    def scroll(
        self,
        *,
        delta_y: int = 0,
        delta_x: int = 0,
        x: float | None = None,
        y: float | None = None,
        app: str | int | None = None,
        coordinate_space: str = "screen",
    ) -> dict[str, Any]:
        """Wheel the pointer over a window; positive ``delta_y`` scrolls up.

        The target is focused (and the pointer parked over ``{x, y}`` when
        given) before the wheel event, because a scroll lands wherever the
        compositor currently points. Scrolling always moves on-screen content,
        so it is never background_safe.
        """
        window = self._resolve_window(app)
        self._require_input_allowed("scroll")
        self.ydotool.require()
        transaction = self._transaction("scroll")
        with transaction:
            focused = transaction.focus_target(window)
            if x is not None and y is not None:
                point = self._screen_point(
                    float(x), float(y), coordinate_space, window
                )
                transaction.move_pointer(*self._reproject(point, window, focused))
            self.ydotool.scroll(int(delta_y), int(delta_x))
        report = transaction.report()
        return _honesty(
            "ydotool",
            background_safe=False,
            interference=[*report["interference"], "scroll"],
            warnings=report["warnings"],
            target=window["address"],
            delta_x=int(delta_x),
            delta_y=int(delta_y),
        )

    def drag(
        self,
        *,
        x1: float,
        y1: float,
        x2: float,
        y2: float,
        app: str | int | None = None,
        button: str = "left",
        coordinate_space: str = "screen",
        steps: int = _DRAG_STEPS,
    ) -> dict[str, Any]:
        """Press at ``{x1, y1}``, move through waypoints to ``{x2, y2}``, release.

        The intermediate waypoints matter: a drag that teleports the pointer
        emits no motion events, and canvas / drag-and-drop targets need those to
        register anything. ``transaction.move_pointer`` records each waypoint as
        the expected cursor, so the transaction's cursor-restore sees the drag's
        own last position rather than a false user-race.
        """
        window = self._resolve_window(app)
        self._require_input_allowed("drag")
        self.ydotool.require()
        start = self._screen_point(float(x1), float(y1), coordinate_space, window)
        end = self._screen_point(float(x2), float(y2), coordinate_space, window)
        transaction = self._transaction("drag")
        with transaction:
            focused = transaction.focus_target(window)
            waypoints = self._interpolate(start, end, steps)
            transaction.move_pointer(*self._reproject(waypoints[0], window, focused))
            self.ydotool.button_down(button)
            try:
                for waypoint in waypoints[1:]:
                    transaction.move_pointer(
                        *self._reproject(waypoint, window, focused)
                    )
            finally:
                # Release the button even if a move mid-drag raises, or the
                # pointer stays stuck down for every later op.
                self.ydotool.button_up(button)
        report = transaction.report()
        return _honesty(
            "ydotool",
            background_safe=report["background_safe"],
            interference=report["interference"],
            warnings=report["warnings"],
            target=window["address"],
            button=button,
        )

    def mouse_move(
        self,
        *,
        x: float,
        y: float,
        app: str | int | None = None,
        coordinate_space: str = "screen",
    ) -> dict[str, Any]:
        """Park the pointer at a coordinate and leave it there (a hover).

        Unlike click/drag, the pointer is *not* restored: a hover the caller
        cannot see would be pointless. It rides a no-cursor-restore transaction
        that still takes the lock, refuses on a locked session, and restores
        focus/workspace - only the cursor is left where it was moved. A bare
        screen-space move needs no window at all; a window-space move (or an
        explicit ``app``) focuses the target so the local coordinate resolves.
        """
        if app is None and coordinate_space == "screen":
            transaction = _NoCursorRestoreTransaction(
                self.hyprctl, self.ydotool, operation="mouse_move", runner=self._runner
            )
            self._require_input_allowed("mouse_move")
            self.ydotool.require()
            with transaction:
                transaction.move_pointer(float(x), float(y))
            report = transaction.report()
            return _honesty(
                "ydotool",
                background_safe=report["background_safe"],
                interference=report["interference"],
                warnings=[*report["warnings"], _HOVER_WARNING],
                x=float(x),
                y=float(y),
            )
        window = self._resolve_window(app)
        self._require_input_allowed("mouse_move")
        self.ydotool.require()
        point = self._screen_point(float(x), float(y), coordinate_space, window)
        transaction = _NoCursorRestoreTransaction(
            self.hyprctl, self.ydotool, operation="mouse_move", runner=self._runner
        )
        with transaction:
            focused = transaction.focus_target(window)
            transaction.move_pointer(*self._reproject(point, window, focused))
        report = transaction.report()
        return _honesty(
            "ydotool",
            background_safe=report["background_safe"],
            interference=report["interference"],
            warnings=[*report["warnings"], _HOVER_WARNING],
            target=window["address"],
        )

    # --- ops: capture ----------------------------------------------------

    def capture(
        self,
        *,
        target: str = "window",
        name: str | int | None = None,
        address: str | None = None,
        region: dict[str, float] | None = None,
        output: str | None = None,
    ) -> dict[str, Any]:
        if target == "window":
            return self._capture_window(address or name)
        if target == "screen":
            return self._capture_output(output)
        if target == "region":
            if not region:
                raise OmaHarnessError("capture target 'region' needs a region rect")
            return self._capture_region(region)
        raise OmaHarnessError(
            f"Unknown capture target {target!r}; use 'window', 'screen', or 'region'"
        )

    def _capture_window(self, query: str | int | None) -> dict[str, Any]:
        window = self._resolve_window(query)
        result = self.capture_router.capture(
            window, background_fallback=self._headless_fallback
        )
        payload = self._encode_png(result)
        window = result.get("client", window)
        payload.update(
            {
                "address": window["address"],
                "app": window["class"] or window["initial_class"],
                "bounds": result.get("bounds") or window.get("bounds"),
            }
        )
        return payload

    def _headless_fallback(
        self, client: dict[str, Any], output: Path, warnings: list[str]
    ) -> dict[str, Any] | None:
        if not self.allow_headless_capture:
            return None
        visible = not client.get("hidden", False) and client.get("mapped", True)
        active = self.hyprctl.active_workspace().get("id")
        on_active = (client.get("workspace") or {}).get("id") == active
        if visible and on_active:
            return None
        try:
            return self.headless.capture(client, output)
        except (CapabilityError, OmaHarnessError) as exc:
            process.unlink_quietly(output)
            warnings.append(f"headless-output capture unavailable: {exc}")
            return None
        except ImportError as exc:
            # The headless rung crops the parked window out of a full-output
            # PNG with Pillow, which is only an optional extra. On a stock
            # install its `from PIL import Image` raises ImportError - neither a
            # CapabilityError nor an OmaHarnessError - so without this it would
            # escape the ladder and fail the whole capture instead of degrading
            # to the focused-region rung. Treat a missing Pillow as this rung
            # simply being unavailable.
            process.unlink_quietly(output)
            warnings.append(
                "headless-output capture unavailable: Pillow (PIL) is not "
                "installed, so a headless-output capture cannot be cropped to "
                f"the window ({exc}); install the 'pillow' extra to enable it"
            )
            return None

    def _capture_output(self, output: str | None) -> dict[str, Any]:
        monitors = self.hyprctl.monitors()
        if output is not None:
            matches = [m for m in monitors if m["name"] == output]
            if not matches:
                raise OmaHarnessError(f"No active output is named {output!r}")
            monitor = matches[0]
        else:
            focused = [m for m in monitors if m.get("focused")]
            if len(focused) == 1:
                monitor = focused[0]
            elif len(monitors) == 1:
                monitor = monitors[0]
            else:
                raise OmaHarnessError(
                    "Specify an output name; no single focused output was reported"
                )
        if not self.capture_router.capabilities().installed:
            raise CapabilityError("grim is not installed; output capture is unavailable")
        path = self._temp_png("output")
        result = self._runner(
            ["grim", "-t", "png", "-o", monitor["name"], str(path)], timeout=6.0
        )
        if not result.ok:
            process.unlink_quietly(path)
            raise OmaHarnessError(f"grim output capture failed: {result.detail()}")
        return self._encode_png(
            {
                "path": str(path),
                "backend": "grim-output",
                "capture_mode": "output",
                "background_safe": True,
                "interference": [],
                "warnings": [],
                "output": monitor["name"],
            }
        )

    def _capture_region(self, region: dict[str, float]) -> dict[str, Any]:
        if not self.capture_router.capabilities().installed:
            raise CapabilityError("grim is not installed; region capture is unavailable")
        path = self._temp_png("region")
        result = self._runner(
            ["grim", "-t", "png", "-g", region_argument(region), str(path)],
            timeout=6.0,
        )
        if not result.ok:
            process.unlink_quietly(path)
            raise OmaHarnessError(f"grim region capture failed: {result.detail()}")
        return self._encode_png(
            {
                "path": str(path),
                "backend": "grim-region",
                "capture_mode": "region",
                # grim -g reads composited output: it cannot see an occluded or
                # off-workspace window, but it changes nothing the user sees.
                "background_safe": True,
                "interference": [],
                "warnings": [
                    "region capture reads only currently-composited pixels; "
                    "occluded or off-workspace content will not appear"
                ],
                "region": region,
            }
        )

    @staticmethod
    def _temp_png(kind: str) -> Path:
        handle = tempfile.NamedTemporaryFile(
            prefix=f"ghost-desktop-{kind}-", suffix=".png", delete=False
        )
        handle.close()
        return Path(handle.name)

    @staticmethod
    def _encode_png(result: dict[str, Any]) -> dict[str, Any]:
        path = Path(result["path"])
        try:
            width, height = png_size(path)
            data = path.read_bytes()
        finally:
            process.unlink_quietly(path)
        return {
            "png_base64": base64.b64encode(data).decode("ascii"),
            "width": width,
            "height": height,
            "backend": result.get("backend"),
            "capture_mode": result.get("capture_mode"),
            "background_safe": bool(result.get("background_safe")),
            "interference": list(result.get("interference", [])),
            "warnings": list(result.get("warnings", [])),
            **{
                k: v
                for k, v in result.items()
                if k in ("output", "region", "bounds")
            },
        }

    # --- ops: compositor control -----------------------------------------

    def focus(
        self, *, address: str | None = None, name: str | int | None = None
    ) -> dict[str, Any]:
        window = self._resolve_window(address or name)
        self._require_input_allowed("focus")
        active = self.hyprctl.active_window()
        already = bool(active and active["address"] == window["address"])
        self.hyprctl.focus_window(window["address"])
        return _honesty(
            "hyprland-dispatch",
            background_safe=already,
            interference=[] if already else ["focus-change"],
            target=window["address"],
            grammar=self.hyprctl.encoder.generation,
        )

    def workspace(
        self, *, id: int | str | None = None, name: str | None = None
    ) -> dict[str, Any]:
        selector = id if id is not None else name
        if selector is None:
            raise OmaHarnessError("workspace needs an id or name")
        self._require_input_allowed("workspace")
        current = self.hyprctl.active_workspace()
        self.hyprctl.focus_workspace(selector)
        already = str(current.get("id")) == str(selector) or current.get(
            "name"
        ) == str(selector)
        return _honesty(
            "hyprland-dispatch",
            background_safe=already,
            interference=[] if already else ["workspace-switch"],
            target=str(selector),
            grammar=self.hyprctl.encoder.generation,
        )

    # --- warnings --------------------------------------------------------

    @staticmethod
    def _tree_warnings(
        window: dict[str, Any], nodes: list[dict[str, Any]]
    ) -> list[str]:
        if len(nodes) > _SKELETAL_TREE:
            return []
        identity = f"{window.get('class', '')} {window.get('initial_class', '')}"
        skeletal = (
            f"the AT-SPI tree for {identity.strip() or window['address']} has only "
            f"{len(nodes)} node(s)"
        )
        if any(hint in identity.casefold() for hint in _CHROMIUM_HINTS):
            return [
                f"{skeletal}; Chromium/Electron apps expose their full tree only "
                "with renderer accessibility enabled "
                "(--force-renderer-accessibility=complete). For web content, use "
                "the browser relay instead."
            ]
        return [f"{skeletal}; this application may not implement AT-SPI"]
