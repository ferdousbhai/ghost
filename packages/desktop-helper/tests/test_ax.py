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


def test_ax_query_unknown_role_refuses_and_lists_present():
    d = _desktop(_tree())
    with pytest.raises(Exception) as exc:
        d.ax_query(app="0xaaaa", role="treeview")
    assert "role" in str(exc.value).casefold()


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


def test_ax_set_text_records_replace_and_honesty():
    d = _desktop(_tree())
    d.ax_query(app="0xaaaa")  # snapshot to populate refs
    # the entry is element_index 2 (frame=0, button=1, entry=2)
    result = d.ax_set(ref=2, attribute="text", value="hello")
    assert d._ax_element(2).inserted == ("hello", True)
    assert result["background_safe"] is True


def test_ax_set_focused_reports_focus_change():
    d = _desktop(_tree())
    d.ax_query(app="0xaaaa")
    result = d.ax_set(ref=1, attribute="focused", value=True)
    assert "focus-change" in result["interference"]
    assert result["background_safe"] is False


def test_type_via_atspi_uses_focused_editable():
    d = _desktop(_tree())
    result = d.type("typed", app="0xaaaa")
    assert result["backend"] == "atspi"
    assert result["background_safe"] is True
    assert result["characters"] == 5
