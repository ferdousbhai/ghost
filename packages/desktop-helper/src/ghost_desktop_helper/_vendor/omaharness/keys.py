# Vendored from omarchy-quattro-harness (https://github.com/fabiopauli/omarchy-quattro-harness)
# Original module: src/omaharness/keys.py
# Copyright (c) 2026 Fabio Pauli. Licensed under the MIT License.
# See ghost_desktop_helper/_vendor/omaharness/LICENSE. Vendored UNMODIFIED
# by the Ghost project for ghost-desktop-helper; only this header was added.

"""Chord parsing for the two keyboard routes Omarchy offers.

A chord such as ``"super+shift+k"`` has to be expressible twice:

* as XKB modifier names plus a keysym, for ``hyprctl dispatch sendshortcut``,
  which delivers the chord straight to one window address without touching
  focus, and
* as Linux evdev key codes, for ``ydotool``, which injects into whatever is
  focused and therefore needs a disruptive transaction around it.

Anything this module cannot express in the requested form returns ``None`` so
the caller can pick the other route or refuse - never a silent wrong key.
"""

from __future__ import annotations

import re

#: Canonical modifier name -> (XKB name for hyprctl, evdev code for ydotool).
_MODIFIERS: dict[str, tuple[str, int]] = {
    "shift": ("SHIFT", 42),
    "ctrl": ("CTRL", 29),
    "control": ("CTRL", 29),
    "alt": ("ALT", 56),
    "option": ("ALT", 56),
    "meta": ("SUPER", 125),
    "super": ("SUPER", 125),
    "win": ("SUPER", 125),
    "mod": ("SUPER", 125),
    "cmd": ("SUPER", 125),
    "command": ("SUPER", 125),
}

#: Linux ``input-event-codes.h`` values for the keys a harness actually sends.
EVDEV_CODES: dict[str, int] = {
    "escape": 1,
    "esc": 1,
    "1": 2,
    "2": 3,
    "3": 4,
    "4": 5,
    "5": 6,
    "6": 7,
    "7": 8,
    "8": 9,
    "9": 10,
    "0": 11,
    "minus": 12,
    "-": 12,
    "equal": 13,
    "=": 13,
    "backspace": 14,
    "tab": 15,
    "q": 16,
    "w": 17,
    "e": 18,
    "r": 19,
    "t": 20,
    "y": 21,
    "u": 22,
    "i": 23,
    "o": 24,
    "p": 25,
    "bracketleft": 26,
    "[": 26,
    "bracketright": 27,
    "]": 27,
    "return": 28,
    "enter": 28,
    "a": 30,
    "s": 31,
    "d": 32,
    "f": 33,
    "g": 34,
    "h": 35,
    "j": 36,
    "k": 37,
    "l": 38,
    "semicolon": 39,
    ";": 39,
    "apostrophe": 40,
    "'": 40,
    "grave": 41,
    "`": 41,
    "backslash": 43,
    "\\": 43,
    "z": 44,
    "x": 45,
    "c": 46,
    "v": 47,
    "b": 48,
    "n": 49,
    "m": 50,
    "comma": 51,
    ",": 51,
    "period": 52,
    ".": 52,
    "slash": 53,
    "/": 53,
    "space": 57,
    "capslock": 58,
    "f1": 59,
    "f2": 60,
    "f3": 61,
    "f4": 62,
    "f5": 63,
    "f6": 64,
    "f7": 65,
    "f8": 66,
    "f9": 67,
    "f10": 68,
    "f11": 87,
    "f12": 88,
    "sysrq": 99,
    "print": 99,
    "home": 102,
    "up": 103,
    "pageup": 104,
    "page_up": 104,
    "left": 105,
    "right": 106,
    "end": 107,
    "down": 108,
    "pagedown": 109,
    "page_down": 109,
    "insert": 110,
    "delete": 111,
    "forward_delete": 111,
    "pause": 119,
    "menu": 127,
}

#: Canonical key name -> XKB keysym accepted by ``sendshortcut``.
_KEYSYMS: dict[str, str] = {
    "escape": "Escape",
    "esc": "Escape",
    "return": "Return",
    "enter": "Return",
    "tab": "Tab",
    "space": "space",
    "backspace": "BackSpace",
    "delete": "Delete",
    "forward_delete": "Delete",
    "insert": "Insert",
    "home": "Home",
    "end": "End",
    "pageup": "Prior",
    "page_up": "Prior",
    "pagedown": "Next",
    "page_down": "Next",
    "up": "Up",
    "down": "Down",
    "left": "Left",
    "right": "Right",
    "minus": "minus",
    "-": "minus",
    "equal": "equal",
    "=": "equal",
    "comma": "comma",
    ",": "comma",
    "period": "period",
    ".": "period",
    "slash": "slash",
    "/": "slash",
    "backslash": "backslash",
    "\\": "backslash",
    "semicolon": "semicolon",
    ";": "semicolon",
    "apostrophe": "apostrophe",
    "'": "apostrophe",
    "grave": "grave",
    "`": "grave",
    "bracketleft": "bracketleft",
    "[": "bracketleft",
    "bracketright": "bracketright",
    "]": "bracketright",
    **{f"f{index}": f"F{index}" for index in range(1, 13)},
}

_SPLIT = re.compile(r"\s*\+\s*")


def parse_chord(chord: str) -> tuple[tuple[str, ...], str]:
    """Split ``"super+shift+k"`` into canonical modifiers and one base key.

    A trailing ``+`` names the plus key itself, so ``"ctrl++"`` is understood.
    """
    if not isinstance(chord, str) or not chord.strip():
        raise ValueError("Key chord must be a non-empty string")
    text = chord.strip()
    parts = [part for part in _SPLIT.split(text) if part != ""]
    if text.endswith("+") and (not parts or parts[-1] != "+"):
        parts.append("+")
    if not parts:
        raise ValueError(f"Key chord {chord!r} contains no keys")
    base = parts[-1]
    base = base if len(base) == 1 else base.casefold()
    modifiers: list[str] = []
    for part in parts[:-1]:
        name = part.casefold()
        if name not in _MODIFIERS:
            raise ValueError(f"Unsupported modifier {part!r} in chord {chord!r}")
        canonical = _MODIFIERS[name][0]
        if canonical not in modifiers:
            modifiers.append(canonical)
    return tuple(modifiers), base


def evdev_chord(chord: str) -> tuple[tuple[int, ...], int]:
    """Return ``(modifier_codes, key_code)`` for ydotool injection."""
    modifiers, base = parse_chord(chord)
    lookup = {"SHIFT": 42, "CTRL": 29, "ALT": 56, "SUPER": 125}
    key = base if base in EVDEV_CODES else base.casefold()
    if key not in EVDEV_CODES:
        raise ValueError(
            f"Unsupported key {base!r}; use desktop.type() for arbitrary text"
        )
    return tuple(lookup[name] for name in modifiers), EVDEV_CODES[key]


def hypr_shortcut(chord: str) -> tuple[str, str] | None:
    """Return ``(modmask, keysym)`` for ``sendshortcut``, or ``None``.

    ``None`` means this chord has no unambiguous XKB spelling, which routes the
    caller to the disruptive ydotool path instead of sending a wrong key.
    """
    modifiers, base = parse_chord(chord)
    if base in _KEYSYMS:
        keysym = _KEYSYMS[base]
    elif len(base) == 1 and base.isalnum() and base.isascii():
        keysym = base
    else:
        return None
    return " ".join(modifiers), keysym
