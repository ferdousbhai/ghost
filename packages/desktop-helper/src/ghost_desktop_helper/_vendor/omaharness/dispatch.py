# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/dispatch.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Compositor dispatch, encoded for whichever grammar this Hyprland speaks.

Hyprland changed its dispatcher contract in 0.56. Every release up to 0.55
took a verb and one comma-joined argument string::

    hyprctl dispatch focuswindow address:0x55f1c0ffee

0.56 replaced that with Lua: ``hyprctl dispatch`` now wraps its arguments in
``return hl.dispatch(...)``, so the same intent is spelled as a call into the
``hl.dsp`` namespace with named fields::

    hyprctl dispatch 'hl.dsp.focus{ window = "address:0x55f1c0ffee" }'

The old spelling is not merely deprecated there - it is a Lua syntax error, so
a harness that hard-codes either grammar is broken on half the fleet.

This module is the single place that knows the difference. The rest of the
harness names an *intent* (focus this window, send this chord) and never sees a
wire string, which is also why the tests can assert on intents instead of on
one grammar's punctuation. :func:`detect` establishes which grammar is live by
asking the compositor rather than by guessing from a version number.
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

from .errors import CapabilityError

#: The pre-0.56 grammar: a verb plus one comma-joined argument string.
LEGACY = "legacy-string"

#: The 0.56+ grammar: a Lua call into ``hl.dsp`` with named fields.
LUA = "lua-table"

GENERATIONS = (LEGACY, LUA)

#: Environment override, for pinning the grammar when detection cannot run
#: (offline tests, a compositor that is momentarily unreachable).
ENV_OVERRIDE = "OMAHARNESS_DISPATCH_API"

#: The probe. ``no_op`` is a real Hyprland dispatcher that does nothing at all,
#: which makes it the only dispatch that is safe to send at an unknown
#: compositor purely to learn how it parses. On a pre-0.56 build the whole
#: string is read as a dispatcher name, no such dispatcher exists, and the call
#: fails without side effects.
PROBE = "hl.dsp.no_op()"

#: Every dispatcher this module can name, as a dotted path under ``hl.dsp``.
#: Hyprland ships a LuaLS type stub describing the whole namespace, so these
#: names are checkable against the compositor that is actually installed rather
#: than trusted until a user's screenshot silently stops working.
DISPATCHERS: tuple[str, ...] = (
    "focus",
    "send_shortcut",
    "window.move",
    "window.close",
    "window.kill",
    "workspace.move",
    "no_op",
)

#: Where Hyprland installs the stub. It is documentation, not an API, so a
#: missing file means "cannot check", never "the name is wrong".
STUB_PATH = "/usr/share/hypr/stubs/hl.meta.lua"

#: A Lua dispatch whose *first* argument is a window-selector string, e.g.
#: ``hl.dsp.window.close("address:0x…")``. Under the 0.56 grammar a selector is
#: a named field, so this call form does not address the window at all: the
#: dispatcher runs against whatever is focused, and ``hyprctl`` still answers
#: ``ok``. Matching the selector prefix keeps genuinely positional dispatchers
#: - ``exec_cmd("foot -e …", { workspace = "5 silent" })`` - out of the net,
#: as does requiring a paren-and-quote rather than a paren-and-brace.
_POSITIONAL_SELECTOR = re.compile(
    r"hl\.dsp\.(?P<path>[\w.]+)\s*\(\s*(?P<q>['\"])"
    r"(?P<selector>(?:address|class|title|pid|initialclass|initialtitle):[^'\"]*)"
    r"(?P=q)"
)


def guard_positional_selector(generation: str, args: list[str]) -> None:
    """Refuse a raw dispatch that addresses a window the way Lua will ignore.

    This is the one mistake in the Lua grammar that costs a user something
    real. A misspelled dispatcher name is caught by the stub audit; a wrong
    *argument shape* is caught by nothing, because ``hyprctl dispatch`` exits
    0 and reports ``ok`` either way. On a destructive dispatcher the result is
    that the focused window - not the addressed one - is closed.
    """
    if generation != LUA:
        return
    for arg in args:
        found = _POSITIONAL_SELECTOR.search(arg)
        if found is None:
            continue
        path = found.group("path")
        selector = found.group("selector")
        field = "workspace" if selector.split(":", 1)[0] == "workspace" else "window"
        raise CapabilityError(
            f"hl.dsp.{path}({found.group('q')}{selector}…) passes the selector "
            "positionally, and this compositor's Lua grammar takes selectors "
            f"as named fields. The call would be accepted, answer `ok`, and "
            f"run against the focused window instead. Spell it "
            f'hl.dsp.{path}{{ {field} = "{selector}" }} - or use the named '
            "intent, which encodes this for both grammars."
        )


_CLASS = re.compile(r"^---@class\s+(HL\.Dsp\w*Namespace)\s*$")
_FIELD = re.compile(r"^---@field\s+(\w+)\s+(.+?)\s*$")


def parse_stub(text: str) -> frozenset[str]:
    """Extract every dispatcher name from Hyprland's own Lua type stub.

    The stub declares one ``---@class HL.Dsp*Namespace`` per level. A field
    typed ``fun(...)`` is a dispatcher; a field typed as another namespace
    class is a level, and its own class supplies that level's names.
    """
    classes: dict[str, dict[str, str]] = {}
    current: dict[str, str] | None = None
    for line in text.splitlines():
        stripped = line.strip()
        match = _CLASS.match(stripped)
        if match is not None:
            current = classes.setdefault(match.group(1), {})
            continue
        if stripped.startswith("---@class") or stripped.startswith("local "):
            current = None
            continue
        if current is None:
            continue
        field = _FIELD.match(stripped)
        if field is not None:
            current[field.group(1)] = field.group(2)

    names: set[str] = set()

    def walk(class_name: str, prefix: str, seen: frozenset[str]) -> None:
        if class_name in seen:  # pragma: no cover - the stub is a tree
            return
        for field, kind in classes.get(class_name, {}).items():
            dotted = f"{prefix}{field}"
            if kind.startswith("fun("):
                names.add(dotted)
            elif kind in classes:
                walk(kind, f"{dotted}.", seen | {class_name})

    walk("HL.DspNamespace", "", frozenset())
    return frozenset(names)


def stub_dispatchers(path: str | None = None) -> frozenset[str] | None:
    """Return the installed compositor's dispatcher vocabulary, or ``None``."""
    try:
        text = Path(path or STUB_PATH).read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    return parse_stub(text) or None

_LUA_ESCAPES = {
    "\\": "\\\\",
    '"': '\\"',
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}

_VERSION = re.compile(r"v?(\d+)\.(\d+)")


def lua_string(value: Any) -> str:
    """Quote one Lua string literal, escaping everything that could break out."""
    out: list[str] = ['"']
    for char in str(value):
        escape = _LUA_ESCAPES.get(char)
        if escape is not None:
            out.append(escape)
        elif ord(char) < 0x20 or ord(char) == 0x7F:
            # Three digits always, so a following digit cannot be swallowed
            # into the escape.
            out.append(f"\\{ord(char):03d}")
        else:
            out.append(char)
    out.append('"')
    return "".join(out)


def lua_value(value: Any) -> str:
    """Render one Python value as the Lua literal Hyprland expects."""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return repr(value)
    return lua_string(value)


def lua_table(fields: dict[str, Any]) -> str:
    """Render a Lua table constructor, dropping ``None`` fields entirely.

    Field order follows insertion order so the encoding is deterministic and
    diffable in test failures.
    """
    body = ", ".join(
        f"{name} = {lua_value(value)}"
        for name, value in fields.items()
        if value is not None
    )
    return "{ " + body + " }" if body else "{}"


def workspace_selector(workspace: int | str) -> int | str:
    """Normalize a workspace selector for either grammar.

    A bare integer stays an integer - Lua's ``workspace = 3`` and the legacy
    ``workspace 3`` both mean workspace 3 - while names keep their
    ``name:`` prefix untouched.
    """
    if isinstance(workspace, bool):  # pragma: no cover - guarded by typing
        raise TypeError("a workspace selector is never a boolean")
    if isinstance(workspace, int):
        return workspace
    text = str(workspace).strip()
    if not text:
        raise CapabilityError("Refusing to dispatch an empty workspace selector")
    try:
        return int(text)
    except ValueError:
        return text


def window_selector(address: str) -> str:
    """Normalize a window address into the selector both grammars accept."""
    text = str(address).strip()
    if not text:
        raise CapabilityError("Refusing to dispatch at an empty window address")
    return text if ":" in text else f"address:{text}"


class DispatchEncoder:
    """Turn a named intent into the argument list ``hyprctl dispatch`` wants.

    Every method returns the arguments *after* ``dispatch``, so the caller
    never has to know that the Lua grammar packs everything into one argv slot
    while the legacy grammar uses two.
    """

    def __init__(self, generation: str = LUA) -> None:
        if generation not in GENERATIONS:
            raise ValueError(
                f"Unknown dispatch generation {generation!r}; "
                f"expected one of {GENERATIONS}"
            )
        self.generation = generation

    @property
    def lua(self) -> bool:
        return self.generation == LUA

    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return f"DispatchEncoder({self.generation!r})"

    # --- intents ---------------------------------------------------------

    def focus_window(self, address: str) -> list[str]:
        target = window_selector(address)
        if self.lua:
            return [f"hl.dsp.focus{lua_table({'window': target})}"]
        return ["focuswindow", target]

    def focus_workspace(self, workspace: int | str) -> list[str]:
        selector = workspace_selector(workspace)
        if self.lua:
            return [f"hl.dsp.focus{lua_table({'workspace': selector})}"]
        return ["workspace", str(selector)]

    def send_shortcut(self, modifiers: str, key: str, address: str) -> list[str]:
        target = window_selector(address)
        if self.lua:
            fields = {"mods": modifiers, "key": key, "window": target}
            return [f"hl.dsp.send_shortcut{lua_table(fields)}"]
        return ["sendshortcut", f"{modifiers},{key},{target}"]

    def move_window_to_workspace(
        self, workspace: int | str, address: str, *, follow: bool = False
    ) -> list[str]:
        """Move a window to a workspace.

        ``follow=False`` is the old ``movetoworkspacesilent``: the window
        moves but the user's view does not follow it. That is the only variant
        the harness ever wants, because following would be exactly the
        disruption the harness promises not to cause.
        """
        selector = workspace_selector(workspace)
        target = window_selector(address)
        if self.lua:
            fields = {"workspace": selector, "window": target, "follow": follow}
            return [f"hl.dsp.window.move{lua_table(fields)}"]
        verb = "movetoworkspace" if follow else "movetoworkspacesilent"
        return [verb, f"{selector},{target}"]

    def close_window(self, address: str, *, kill: bool = False) -> list[str]:
        """Close one window by address, never "whatever is focused".

        The distinction matters more here than anywhere else in this module.
        Both grammars accept a call that names no window, and both interpret
        it as the active one, so an encoding slip does not fail - it closes
        the wrong window and reports success.

        ``kill=True`` is the ungraceful variant: it takes the process down
        rather than asking the window to close.
        """
        target = window_selector(address)
        if self.lua:
            verb = "kill" if kill else "close"
            return [f"hl.dsp.window.{verb}{lua_table({'window': target})}"]
        return ["killwindow" if kill else "closewindow", target]

    def move_workspace_to_monitor(
        self, workspace: int | str, monitor: str
    ) -> list[str]:
        selector = workspace_selector(workspace)
        name = str(monitor).strip()
        if not name:
            raise CapabilityError("Refusing to dispatch at an empty monitor name")
        if self.lua:
            fields = {"workspace": selector, "monitor": name}
            return [f"hl.dsp.workspace.move{lua_table(fields)}"]
        return ["moveworkspacetomonitor", f"{selector} {name}"]

    def plugin(self, name: str, payload: str) -> list[str]:
        """Dispatch into a dispatcher a plugin registered.

        Under the legacy grammar a plugin's dispatcher is addressed by the
        exact name it registered. Under Lua, dispatcher registration moved
        inside ``hl.dsp`` and Hyprland 0.56 has not settled how a plugin's own
        entry is spelled there, so this refuses rather than guessing at a name
        that would silently do nothing.
        """
        if self.lua:
            raise CapabilityError(
                f"The native extension registers the dispatcher {name!r} using "
                "the pre-0.56 plugin API, and this compositor speaks the Lua "
                "dispatcher grammar. Stage 2 background input is unavailable "
                "until the extension is ported; Stage 1 capture and "
                "sendshortcut are unaffected."
            )
        return [name, payload]


def from_version(version: dict[str, Any] | None) -> str | None:
    """Infer the grammar from a reported version tag, or return ``None``.

    This is a hint, never the decision: git builds, distro patches, and
    forks all report tags that mean less than they look like they do.
    :func:`detect` prefers asking the compositor.
    """
    if not version:
        return None
    match = _VERSION.search(str(version.get("tag") or ""))
    if match is None:
        return None
    major, minor = int(match.group(1)), int(match.group(2))
    return LUA if (major, minor) >= (0, 56) else LEGACY


def audit_dispatchers(generation: str, *, path: str | None = None) -> dict[str, Any]:
    """Check every name this module emits against the installed compositor.

    Hyprland renames dispatchers between minor releases, and a renamed one is
    silent: ``hyprctl dispatch`` still exits 0 and answers ``warning: ... not
    found``. The compositor ships the authoritative list as a type stub, so the
    harness can be told it is out of date instead of a user discovering it when
    a window refuses to focus.
    """
    if generation != LUA:
        return {"checked": False, "reason": "the legacy grammar has no type stub"}
    known = stub_dispatchers(path)
    if known is None:
        return {"checked": False, "reason": f"no dispatcher stub at {path or STUB_PATH}"}
    missing = sorted(name for name in DISPATCHERS if name not in known)
    return {
        "checked": True,
        "known": len(known),
        "unknown_dispatchers": missing,
    }


def detect(probe: Any, *, version: dict[str, Any] | None = None) -> dict[str, Any]:
    """Establish which dispatcher grammar this compositor speaks.

    ``probe`` is called with the encoded no-op and must return ``True`` when
    the compositor accepted it. The result records *how* the answer was
    reached, because "we asked the compositor" and "we read a version string"
    are not the same quality of evidence and ``doctor`` reports both.
    """
    override = os.environ.get(ENV_OVERRIDE, "").strip()
    if override:
        if override not in GENERATIONS:
            raise CapabilityError(
                f"{ENV_OVERRIDE}={override!r} is not a dispatch grammar; "
                f"expected one of {', '.join(GENERATIONS)}"
            )
        return {
            "generation": override,
            "detected_by": "environment",
            "evidence": f"{ENV_OVERRIDE}={override}",
        }

    hint = from_version(version)
    try:
        accepted = bool(probe([PROBE]))
    except Exception as exc:  # noqa: BLE001 - any failure means "not Lua"
        accepted = False
        note = str(exc)
    else:
        note = "accepted" if accepted else "rejected"

    generation = LUA if accepted else LEGACY
    detected = {
        "generation": generation,
        "detected_by": "probe",
        "evidence": f"hyprctl dispatch '{PROBE}' {note}"[:400],
    }
    if hint is not None and hint != generation:
        # Worth surfacing: it usually means a patched or mislabelled build,
        # and the probe is the one that gets believed.
        detected["version_hint"] = hint
        detected["note"] = (
            f"the reported version suggested {hint}, but the compositor "
            f"behaves as {generation}; the probe wins"
        )
    return detected


__all__ = [
    "DISPATCHERS",
    "ENV_OVERRIDE",
    "GENERATIONS",
    "LEGACY",
    "LUA",
    "PROBE",
    "STUB_PATH",
    "DispatchEncoder",
    "audit_dispatchers",
    "detect",
    "from_version",
    "lua_string",
    "lua_table",
    "lua_value",
    "parse_stub",
    "stub_dispatchers",
    "window_selector",
    "workspace_selector",
]
