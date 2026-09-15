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
- **Hyprland dispatcher-grammar correctness** — auto-detected 0.55 string vs
  0.56+ `hl.dsp.*` Lua grammar (see below).

Vision is **not** here: semantic (AT-SPI) access is preferred where it exists.
A chat model that accepts images reads `ghost_screen`'s image block directly;
a blind one hands the saved frame to Ghost's `inspect_image`, which resolves
the `advisor_model` the ghost binds in `models.json`. The strongest path uses
both — try semantic, fall back to a screenshot + vision.

There is deliberately **no `exec` op**: this is desktop control only. The ghost
already has the harness's native Bash.

## Transport

One process. One request object per line in, one response object per line out,
correlated by `id`. Stderr is logs.

```
request:  {"id": <n>, "op": "<name>", "args": { ... }}
response: {"id": <n>, "ok": true,  "result": { ... }}
          {"id": <n>, "ok": false, "error": {"code": "...", "message": "...", "details": {}}}
```

On startup the helper emits an unsolicited `hello` line (also available as the
`hello` op) reporting helper version, Hyprland version, the detected dispatcher
grammar, and which backends are actually available:

```json
{"type":"hello","helper":"ghost-desktop-helper","version":"0.1.0","protocol":2,
 "ops":[...], "in_hyprland_session":true,
 "hyprland-version":{"tag":"v0.56.2", ...},
 "detected-dispatch-grammar":{"generation":"lua-table","detected_by":"probe",
   "evidence":"hyprctl dispatch 'hl.dsp.no_op()' accepted", "dispatchers":{...}},
 "available-backends":{"hyprctl":{...},"grim":{...,"foreign_toplevel":true},
   "wtype":{...},"ydotool":{...,"usable":false},"atspi":{"available":true,...},
   "foreign_toplevel_protocol":{"supported":true}}}
```

Every **capture / input / perform** result carries honesty metadata:

```json
{"backend":"grim-foreign-toplevel","background_safe":true,
 "interference":[],"warnings":[]}
```

The helper **refuses rather than fakes**: a missing backend, a locked session,
or an unreadable value is a structured error with remediation, never a blank
screenshot or an empty tree dressed up as success.

## Ops

The op vocabulary, arguments, and error codes are the contract in
[`docs/desktop-helper.md`](../../docs/desktop-helper.md); `hello` advertises
the ops a running helper actually supports. The table below is a summary.

| Op | Args | Result |
|----|------|--------|
| `see` | `{name?}` | windows matching (address, title, class, workspace, geometry, focused) |
| `state` | — | condensed clients + workspaces + activeworkspace + activewindow + monitors |
| `layers` | `{namespace?, output?}` | wlr-layer-shell surfaces with logical geometry |
| `toplevels` | `{timeout?}` | `ext-foreign-toplevel-list-v1` list reconciled with hyprctl clients |
| `ax_query` | `{app?, role?, text?, attributes?, limit?}` | matching AT-SPI elements (role, name, text, bounds, actions, `ref`) |
| `ax_roles` | `{app?}` | role → count for an app's tree |
| `ax_perform` | `{ref, action}` | invoke a semantic action; honesty metadata |
| `ax_set` | `{ref, attribute, value}` | set `text` / `value` / `focused`; honesty metadata |
| `hit_test` | `{x, y, app?}` | resolve a screen coordinate to the AT-SPI element under it, minting a fresh `ref`; refuses when no node has trustworthy bounds |
| `key` | `{chord, app?, prefer_dispatch?}` | keyboard chord (sendshortcut, else ydotool); honesty metadata |
| `type` | `{text, app?, ref?, replace?}` | text via AT-SPI insert or `wtype`; `replace` overwrites; honesty metadata |
| `click` | `{x, y, coordinate_space?} \| {ref}`, `{button?, clicks?}` | pointer click (ref resolves via AT-SPI bounds); `button` left/right/middle, `clicks` for multi-click; honesty metadata |
| `drag` | `{x1, y1, x2, y2, app?, button?, coordinate_space?, steps?}` | press → move through interpolated waypoints → release (canvas / drag-and-drop); honesty metadata |
| `scroll` | `{delta_y, delta_x?, x?, y?, app?, coordinate_space?}` | wheel the focused window (positive `delta_y` up), optionally over `{x, y}`; never background-safe; honesty metadata |
| `mouse_move` | `{x, y, app?, coordinate_space?}` | park the pointer at a coordinate (a hover); left there, not restored; honesty metadata |
| `capture` | `{target:"window"\|"screen"\|"region", name?, address?, region?, output?}` | base64 PNG; window uses the 3-tier ladder, while screen/region directly read composited pixels with provenance; producer output is limited to 8 MiB |
| `focus` | `{address \| name}` | focus a window; honesty metadata |
| `workspace` | `{id \| name}` | switch workspace; honesty metadata |
| `hello` | — | the complete diagnostic/handshake payload above; degraded backends include reasons |

Roles use a unified GTK3/4 vocabulary (`push button` and `button` fold to one);
`ax_query` refuses an unknown role and lists the ones actually present.

Element `ref`s are opaque `"epoch:index"` strings minted by the most recent
`ax_query` / `ax_roles` snapshot (the epoch bumps on every new snapshot, so a
ref from an earlier one is detectably stale rather than silently redirected).
Pass a ref back verbatim; take a fresh snapshot before reusing them.

### Safety

- **Session lock, fail closed.** Every mutating op (`key`, `type`, `click`,
  `drag`, `scroll`, `mouse_move`, `ax_perform`, `ax_set`, `focus`, `workspace`)
  refuses when the session is locked — or when neither Hyprland nor logind can
  say whether it is. (`hit_test` is a read, like `ax_query`.)
- **`fcntl` transaction locking.** The one path that must temporarily change
  compositor state (focused-region capture, injected input) takes a
  single-writer lock under `$XDG_RUNTIME_DIR`, snapshots focus/workspace/cursor,
  does the work, restores, and reports the interference. Concurrent calls cannot
  interleave their snapshot/restore windows; a user who moved the pointer
  mid-flight gets a reported race, not a yanked cursor.

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
