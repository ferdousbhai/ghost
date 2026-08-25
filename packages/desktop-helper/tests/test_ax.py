"""AT-SPI bridge glue: tree walk, role vocabulary, ref registry, perform/set.

Uses a synthetic AtspiBackend so the logic is exercised without a compositor or
PyGObject. Complements the live probe (which confirms the real bindings import
and apps enumerate) by pinning the parts that are *ours*: filtering, the element
ref registry, and honesty metadata on semantic writes.
"""

from __future__ import annotations

import pytest
from conftest import FakeHyprctl, sample_window, unlocked_runner

from ghost_desktop_helper.bridge import GhostDesktop


class Node:
    def __init__(self, role, name="", states=(), actions=(), children=(),
                 editable=False):
        self.role = role
        self.name = name
        self.states = list(states) + (["editable"] if editable else [])
        self.actions = list(actions)
        self.children = list(children)
        self.did = []          # recorded do_action calls
        self.inserted = None   # recorded insert_text
        self.set_val = None    # recorded set_value


class FakeAtspi:
    """Minimal AccessibleTree-compatible backend over Node objects."""

    def __init__(self, root):
        self._root = root

    # discovery
    def application_for_pid(self, pid):
        return self._root

    # node properties
    def role(self, n):
        return n.role

    def name(self, n):
        return n.name

    def description(self, n):
        return ""

    def text(self, n):
        return None

    def value(self, n):
        return None

    def states(self, n):
        return list(n.states)

    def actions(self, n):
        return list(n.actions)

    def settable(self, n):
        out = []
        if "editable" in n.states:
            out.append("text")
        if "focusable" in n.states:
            out.append("focused")
        return out

    def extents(self, n, *, relative_to_window):
        return None

    def child_count(self, n):
        return len(n.children)

    def child(self, n, i):
        return n.children[i] if 0 <= i < len(n.children) else None

    # writes
    def do_action(self, n, action):
        n.did.append(action)
        return True

    def insert_text(self, n, value, replace=False):
        n.inserted = (value, replace)
        return True

    def set_value(self, n, value):
        n.set_val = value
        return True

    def grab_focus(self, n):
        return True

    def is_editable(self, n):
        return "editable" in n.states

    def implements(self, n, iface):
        return False


def _desktop(root):
    hyprctl = FakeHyprctl(_clients=[sample_window(pid=4242)])
    return GhostDesktop(
        hyprctl=hyprctl, runner=unlocked_runner, atspi_backend=FakeAtspi(root)
    )


def _tree():
    button = Node("push button", name="Save", actions=["click"], states=["focusable"])
    entry = Node("entry", name="", editable=True, states=["focused"])
    return Node("frame", name="win", children=[button, entry])


def test_ax_query_finds_by_role_and_registers_refs():
    d = _desktop(_tree())
    result = d.ax_query(app="0xaaaa", role="button")
    assert result["count"] == 1
    el = result["elements"][0]
    # GTK3 "push button" folds onto canonical "button"
    assert el["role"] == "push button"
    assert "ref" in el
    # the ref resolves back to a live node
    assert d._ax_element(el["ref"]) is not None


def test_ax_query_unknown_role_returns_empty_with_present_roles():
    d = _desktop(_tree())
    # A zero-match role is a normal empty read (consistent with a zero-match
    # text filter), not a raise; the present roles come back as a warning so the
    # model can recover in one round-trip.
    result = d.ax_query(app="0xaaaa", role="treeview")
    assert result["count"] == 0
    assert result["elements"] == []
    warning = " ".join(result["warnings"]).casefold()
    assert "treeview" in warning
    assert "button" in warning  # the roles that ARE present are listed


def test_ax_roles_counts_canonical():
    d = _desktop(_tree())
    roles = d.ax_roles(app="0xaaaa")["roles"]
    assert roles["button"] == 1
    assert roles["frame"] == 1
    # "entry" folds to canonical "text"
    assert roles.get("text") == 1


def test_ax_perform_invokes_action_with_honesty():
    d = _desktop(_tree())
    q = d.ax_query(app="0xaaaa", role="button")
    ref = q["elements"][0]["ref"]
    result = d.ax_perform(ref=ref, action="click")
    assert result["backend"] == "atspi"
    assert {"background_safe", "interference", "warnings"} <= set(result)
    assert d._ax_element(ref).did == ["click"]


def _ref_for(result, element_index):
    """The minted, epoch-qualified ref for a given element_index in a query."""
    return next(
        el["ref"] for el in result["elements"] if el["element_index"] == element_index
    )


def test_ax_set_text_records_replace_and_honesty():
    d = _desktop(_tree())
    q = d.ax_query(app="0xaaaa")  # snapshot to populate refs
    # the entry is element_index 2 (frame=0, button=1, entry=2)
    ref = _ref_for(q, 2)
    result = d.ax_set(ref=ref, attribute="text", value="hello")
    assert d._ax_element(ref).inserted == ("hello", True)
    assert result["background_safe"] is True


def test_ax_set_focused_reports_focus_change():
    d = _desktop(_tree())
    q = d.ax_query(app="0xaaaa")
    ref = _ref_for(q, 1)  # the focusable button
    result = d.ax_set(ref=ref, attribute="focused", value=True)
    assert "focus-change" in result["interference"]
    assert result["background_safe"] is False


def test_bare_int_ref_is_rejected_as_malformed():
    d = _desktop(_tree())
    d.ax_query(app="0xaaaa")
    from ghost_desktop_helper.bridge import UnknownRefError

    with pytest.raises(UnknownRefError) as exc:
        d.ax_perform(ref=1)  # a bare index carries no epoch to validate
    assert exc.value.details["reason"] == "malformed"


def test_ref_from_earlier_snapshot_rejected_after_new_snapshot():
    """A ref minted by snapshot N is stale once snapshot N+1 replaces the tree.

    This is the core P0: without an epoch, ref 1 from a firefox query would
    silently address whatever element 1 happens to be in the next app's tree.
    """
    from ghost_desktop_helper.bridge import UnknownRefError

    d = _desktop(_tree())
    first = d.ax_query(app="0xaaaa", role="button")
    stale_ref = first["elements"][0]["ref"]
    assert d._ax_epoch == 1

    # A second snapshot (here via ax_roles) bumps the epoch and replaces the table.
    d.ax_roles(app="0xaaaa")
    assert d._ax_epoch == 2

    with pytest.raises(UnknownRefError) as exc:
        d.ax_perform(ref=stale_ref, action="click")
    assert exc.value.details["reason"] == "stale"
    assert exc.value.details["snapshot"] == 1
    assert exc.value.details["current_snapshot"] == 2


def test_type_between_query_and_perform_does_not_invalidate_ref():
    """type() takes a private snapshot; it must not renumber or stale the ref.

    The old code re-snapshotted inside _focused_editable and overwrote the ref
    table, so a bare type() between a query and a perform redirected the ref.
    """
    d = _desktop(_tree())
    q = d.ax_query(app="0xaaaa", role="button")
    ref = q["elements"][0]["ref"]
    epoch_before = d._ax_epoch

    typed = d.type("hi", app="0xaaaa")  # goes through _focused_editable
    assert typed["backend"] == "atspi"
    assert d._ax_epoch == epoch_before  # private snapshot did not bump the epoch

    # The ref still resolves to the same button, and the perform lands on it.
    result = d.ax_perform(ref=ref, action="click")
    assert result["backend"] == "atspi"
    assert d._ax_element(ref).did == ["click"]


def test_walk_knobs_are_clamped_server_side():
    # Hostile / careless arguments are bounded to defensible ceilings.
    assert GhostDesktop._clamp_nodes(10**9) == 5000
    assert GhostDesktop._clamp_nodes(0) == 1
    assert GhostDesktop._clamp_depth(10**9) == 40
    assert GhostDesktop._clamp_depth(-5) == 0
    assert GhostDesktop._clamp_timeout(10**9) == 5.0
    assert GhostDesktop._clamp_timeout("nonsense") == 1.5
    # limit <= 0 means "up to the ceiling", never "unlimited".
    assert GhostDesktop._effective_limit(0) == 200
    assert GhostDesktop._effective_limit(-1) == 200
    assert GhostDesktop._effective_limit(10**9) == 200
    assert GhostDesktop._effective_limit(5) == 5


def test_snapshot_wall_clock_budget_aborts_a_slow_walk():
    """A small tree of pathologically slow nodes still terminates."""
    from ghost_desktop_helper.bridge import _BudgetedTree

    clock = iter([0.0, 0.0, 100.0, 100.0, 100.0, 100.0])
    tree = _BudgetedTree(
        FakeAtspi(_tree()), budget_s=1.0, clock=lambda: next(clock)
    )
    with pytest.raises(Exception) as exc:
        tree.snapshot(_tree())
    assert "budget" in str(exc.value).casefold()


def test_type_via_atspi_uses_focused_editable():
    d = _desktop(_tree())
    result = d.type("typed", app="0xaaaa")
    assert result["backend"] == "atspi"
    assert result["background_safe"] is True
    assert result["characters"] == 5


class HitAtspi(FakeAtspi):
    """FakeAtspi with window-relative extents, so nodes have trustworthy bounds."""

    def __init__(self, root, rects):
        super().__init__(root)
        self._rects = rects  # id(node) -> (x, y, w, h) window-relative

    def extents(self, n, *, relative_to_window):
        # Only the window-relative extent yields a WINDOW_TRANSLATED (trustworthy)
        # rectangle once the window bounds are added; the screen extent is left
        # unavailable, mirroring how Wayland clients usually report.
        return self._rects.get(id(n)) if relative_to_window else None


def test_hit_test_resolves_coordinate_to_element_ref():
    frame = Node("frame", name="win")
    button = Node("push button", name="Save", actions=["click"], states=["focusable"])
    frame.children = [button]
    # window bounds start at (100, 100); button rel (10, 10) => screen (110, 110)
    rects = {id(frame): (0, 0, 800, 600), id(button): (10, 10, 100, 30)}
    hyprctl = FakeHyprctl(_clients=[sample_window(pid=4242)])
    d = GhostDesktop(
        hyprctl=hyprctl, runner=unlocked_runner, atspi_backend=HitAtspi(frame, rects)
    )
    result = d.hit_test(x=120, y=120, app="0xaaaa")
    el = result["element"]
    # the deepest trustworthy node containing the point wins (button over frame)
    assert el["role"] == "push button"
    assert ":" in el["ref"]  # a fresh "epoch:index" ref
    # and it resolves to the live node, closing the coordinate -> ref loop
    assert d._ax_element(el["ref"]) is not None


def test_hit_test_refuses_when_no_trustworthy_bounds():
    # The plain FakeAtspi reports no extents, so nothing has bounds to trust.
    d = _desktop(_tree())
    with pytest.raises(Exception) as exc:
        d.hit_test(x=120, y=120, app="0xaaaa")
    assert "bounds" in str(exc.value).casefold()
