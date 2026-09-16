# ghost-desktop-helper

The ghost's fallback **computer-use sidecar** for Omarchy (Hyprland / Wayland),
used when `omarchy` CLI has no route, a tried route fails, or application
content needs direct manipulation. A single long-lived Python process that the
ghost's TypeScript extensions (`ghost_desktop`, `ghost_screen`) drive over a
line-oriented JSON protocol on stdin/stdout — the same shape as
a QML surface calling out to a Python sidecar over a line protocol.

It gives the ghost the hard desktop capabilities that are natural in PyGObject
and already solved, MIT-licensed, in
[omarchy-quattro-harness](https://github.com/fabiopauli/omarchy-quattro-harness)
by Fabio Pauli:

- **AT-SPI accessibility** — semantic queries, actions, and text/value edits.
- **Background-safe capture** — the grim foreign-toplevel → headless-output →
  focused-region ladder, each rung honestly labelled.
- **Layout-safe input** — `wtype` for text, `hyprctl sendshortcut` / `ydotool`
  for chords, closed-loop pointer moves.
- **Hyprland dispatcher-grammar correctness** — the detected generation is
  `legacy-string` (pre-0.56) or `lua-table` (0.56+ `hl.dsp.*`), overridable
  with `OMAHARNESS_DISPATCH_API` (see below).

Vision is **not** here: semantic (AT-SPI) access is preferred where it exists.
Images are pi's read tool. A chat model that accepts images reads
`ghost_screen`'s image block directly; one that cannot is told the capture was
not attached and gets the saved path. The strongest path uses both — try
semantic, fall back to a screenshot + vision.

There is deliberately **no `exec` op**: this is desktop control only. The ghost
already has the harness's native Bash.

## Protocol

The transport, the op set, the error vocabulary, and the safety rules are one
contract, written once in
[`docs/desktop-helper.md`](../../docs/desktop-helper.md) and validated in
[`protocol.py`](src/ghost_desktop_helper/protocol.py). This package builds and
runs the process that speaks it.

## Hyprland dispatcher grammar (the core fix)

Hyprland changed its dispatcher contract in 0.56. Up to 0.55 a dispatch was a
verb plus one comma-joined string:

```
hyprctl dispatch focuswindow address:0x55f1c0ffee
```

0.56+ wraps arguments in `return hl.dispatch(...)`, so the same intent is a Lua
call with named fields:

```
hyprctl dispatch 'hl.dsp.focus{ window = "address:0x55f1c0ffee" }'
```

On 0.56 the old spelling is not deprecated — it is a **Lua syntax error**, so a
helper that hard-codes either grammar is broken on half the fleet. This helper
detects the live grammar by probing `hl.dsp.no_op()` (a real no-op dispatcher
safe to send at an unknown compositor), caches the answer with its provenance,
and encodes every intent accordingly. Override with the
`OMAHARNESS_DISPATCH_API` environment variable (`lua-table` or `legacy-string`)
when detection can't run.

## Runtime requirements

Most heavy capabilities are **system tools**, detected at runtime; the helper
degrades with a clear "install X" error (and `hello` reports the gap) rather
than crashing when one is absent. Pillow is the one Python runtime dependency:
it crops a full headless-output capture back to the requested window, making
the advertised second capture rung usable.

| Tool | Purpose | Install (Arch/Omarchy) |
|------|---------|------------------------|
| `hyprctl` | compositor inspection + dispatch | `sudo pacman -S hyprland` (present in-session) |
| `grim` (with `-T`) | background-safe + region + output capture | `sudo pacman -S grim` |
| `wtype` | layout-safe text injection | `sudo pacman -S wtype` |
| `ydotool` + `ydotoold` | evdev chords + coordinate clicks | `sudo pacman -S ydotool`; `systemctl --user enable --now ydotool` |
| PyGObject + at-spi2-core | AT-SPI accessibility | `sudo pacman -S python-gobject at-spi2-core` |
| Pillow | crop headless-output captures to the target window | installed with the Python package; `sudo pacman -S python-pillow` on Arch |

Without `ydotool` the helper still observes, captures, sends chords via
`hyprctl sendshortcut`, and types via `wtype`; only raw coordinate clicks and
evdev-only chords refuse. Without PyGObject the `ax_*` ops refuse (with the
exact interpreter-aware remediation) while everything else works.

Python ≥ 3.11. The Python distribution declares `pillow>=10` as a runtime
dependency; the Arch package declares the equivalent `python-pillow>=10`.

### The one system dependency that constrains the interpreter

PyGObject publishes **no wheels** — PyPI carries an sdist only — so `gi` is
never "just a pip install": it is whatever the distro compiled, against exactly
one Python minor version, into `/usr/lib/pythonX.Y/site-packages`. On Omarchy
today `python-gobject` is built for **Python 3.14**, so:

- `.python-version` pins the project to `3.14`, and `[tool.uv]
  python-preference = "only-system"` keeps uv on the system interpreter that
  owns those bindings. A uv-*managed* 3.x would resolve, install, and run — and
  every `ax_*` op would refuse, which is the expensive way to find out.
- The helper appends the matching system `site-packages` to `sys.path` at
  import when (and only when) `gi` is missing from an isolated environment —
  see `_bootstrap_system_gi` in `src/ghost_desktop_helper/__init__.py`. That is
  what makes a plain `uv run` / `uv tool install` work at all, since neither
  can be told `--system-site-packages` from project config. It appends rather
  than prepends (no distro package can shadow the environment) and is guarded
  on the exact minor version. Set `GHOST_DESKTOP_NO_SYSTEM_GI=1` to skip it in
  an environment that compiled its own bindings.

`hello` reports `available-backends.atspi` with the interpreter, the
reason, and the remediation, so a dark accessibility path says so out loud
instead of quietly returning nothing.

## Running

```
# from a source checkout (the private harness ships inside this package)
uv run ghost-desktop-helper
# or
python -m ghost_desktop_helper
```

The TypeScript extensions spawn the helper *by name*: `$GHOST_DESKTOP_HELPER`
if set, else `ghost-desktop-helper` on `PATH`, else `python3 -m
ghost_desktop_helper`. A source checkout is on none of those, so install the
console script once —

```
uv tool install --editable --no-managed-python --python 3.14 .
```

— which puts `ghost-desktop-helper` in `~/.local/bin` pointing back at this
checkout. Without it the ghost's desktop and screen tools fall through to
`python3 -m ghost_desktop_helper`, which cannot import the package at all.

## Tests

Two tiers, mirroring the harness:

```
uv run --with pytest python -m pytest tests -q            # mocked (no compositor)
GHOST_DESKTOP_LIVE=1 uv run --with pytest python -m pytest tests/test_live.py -q
uv run ruff check src tests
uv run mypy
```

The mocked tier covers protocol shaping, dispatch-grammar selection, honesty
metadata, and fail-closed session locking. The live tier runs only read-only /
non-disruptive checks against the real compositor (it never steals focus,
injects input, or switches workspace; the grammar check uses a fake window
address so the dispatcher runs but changes nothing).

## Attribution

`src/ghost_desktop_helper/_vendor/omaharness/` is a minimal, desktop-only
vendor of
[omarchy-quattro-harness](https://github.com/fabiopauli/omarchy-quattro-harness)
at upstream commit
[`5bc268d7558971fbbe4570f6c04cf62a67f93d42`](https://github.com/fabiopauli/omarchy-quattro-harness/tree/5bc268d7558971fbbe4570f6c04cf62a67f93d42)
— Copyright (c) 2026 Fabio Pauli, MIT License (see
`src/ghost_desktop_helper/_vendor/omaharness/LICENSE` and the repo-root
`THIRD_PARTY_NOTICES.md`). Ten leaf modules match that revision after their
provenance headers. Ghost modifies the private initializer, caps repeated click
injection in `inputs.py`, and bounds captured child output in `process.py`. The
browser, CLI, controls, desktop-orchestrator, knowledge, overlay, native-plugin,
pointer, and XWayland modules are intentionally **not** vendored. The thin JSON
bridge in `src/ghost_desktop_helper/` is original Ghost code (Apache-2.0,
matching the workspace).
