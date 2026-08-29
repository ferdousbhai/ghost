# Desktop helper contract (`ghost-desktop-helper`)

The ghost controls the laptop through **Omarchy CLI first**: discover stable
routes with `omarchy commands --json` or group help, then run
`omarchy <group> <action>` through Bash. The **Python sidecar is the fallback**
when Omarchy has no route, a tried CLI route fails, or the task must manipulate
content inside an arbitrary application. Its hard capabilities (AT-SPI
accessibility, background-safe capture, layout-safe input, and Hyprland
dispatcher-grammar correctness) are natural in PyGObject and already solved,
MIT-licensed, in
[omarchy-quattro-harness](https://github.com/fabiopauli/omarchy-quattro-harness)
by Fabio Pauli. We **vendor its desktop modules** (attributed in
THIRD_PARTY_NOTICES) behind our own thin JSON bridge, and drop its browser
(we have our own relay + Playwright). Our TS `ghost_desktop`/`ghost_screen`
extensions shell to this sidecar — the same shape as `TrayBridge.qml` →
`ghost-tray.py`.

Vision is NOT in the helper. Once the helper fallback is needed, semantic
(AT-SPI) access is preferred where it exists (GTK); Ghost's `inspect_image` —
which resolves the `vision_model` role Ghost binds from `models.json` — is the
universal fallback for
canvas/Qt-without-a11y/web/games. The strongest path uses both: try semantic,
fall back to a screenshot + vision.

## Transport

One long-lived process, `ghost-desktop-helper` (or `python -m
ghost_desktop_helper`). Line-oriented JSON on stdin/stdout: one request object
per line → one response object per line, correlated by `id`. Stderr is logs.
A `hello` handshake reports helper version, Hyprland version, detected
dispatcher grammar, and which capabilities/backends are actually available
(grim foreign-toplevel? wtype? ydotool? AT-SPI bus?).

Request:  `{ "id": <n>, "op": "<name>", "args": { ... } }`
Response: `{ "id": <n>, "ok": true, "result": { ... } }`
       |  `{ "id": <n>, "ok": false, "error": { "code": "...", "message": "...", "details": {} } }`

Every capture/input/perform result carries **honesty metadata** (from the
harness's model): `{ backend, background_safe, interference: [...], warnings:
[...] }`. Never return a blank/faked result — refuse with a clear error and
say why.

## Ops

Windows / desktop state
- `see` `{ name? }` → windows matching (address, title, class, workspace, geometry, focused).
- `state` → condensed clients + workspaces + activewindow (what `ghost_desktop` state returns today, but sourced here).
- `layers` → wlr-layer-shell surfaces with logical geometry + scale.
- `toplevels` → `ext-foreign-toplevel-list-v1` list (background-capturable).

Accessibility (the big gap we're closing — AT-SPI)
- `ax_query` `{ app?, role?, text?, attributes? }` → matching elements (role, name, text, bounds, actions, id/path). Unified GTK3/4 role vocabulary; refuse unknown roles and list valid ones.
- `ax_roles` `{ app }` → available roles for an app.
- `ax_perform` `{ ref, action }` → invoke a semantic action (press, click, expand, …). Returns honesty metadata.
- `ax_set` `{ ref, attribute, value }` → set an attribute (e.g. text value).
- `hit_test` `{ x, y, app? }` → resolve a screen coordinate to the AT-SPI element under it, minting a fresh `ref`. Closes the screenshot→coordinate→semantic-ref loop; refuses (rather than guesses) when no node offers trustworthy bounds.

Input (layout-safe)
- `key` `{ chord }` → keyboard chord. Prefer AT-SPI action / `hyprctl sendshortcut`; fall back to `ydotool` (flag layout-unsafe in warnings).
- `type` `{ text, ref?, replace? }` → text via AT-SPI insert or `wtype` (layout-safe). `replace: true` overwrites the field instead of inserting.
- `click` `{ x, y } | { ref }`, `{ button?, clicks? }` → pointer click (ref resolves via AT-SPI bounds). `button` is left/right/middle; `clicks` ≥ 2 is a multi-click.
- `drag` `{ x1, y1, x2, y2, app?, button?, coordinate_space?, steps? }` → press at the start, move through interpolated waypoints (so canvas / drag-and-drop targets see the motion events), release at the end, inside one transaction.
- `scroll` `{ delta_y, delta_x?, x?, y?, app?, coordinate_space? }` → wheel the focused window (positive `delta_y` scrolls up); optionally park the pointer over `{x, y}` first. Never background-safe — it moves on-screen content.
- `mouse_move` `{ x, y, app?, coordinate_space? }` → park the pointer at a coordinate (a hover). Unlike click/drag the pointer is **left there**, not restored; it rides a no-cursor-restore transaction that keeps every other guardrail (lock, focus/workspace restore).

Capture (the ladder + honesty)
- `capture` `{ target: "window"|"screen"|"region", name?, address?, region?, output? }` → PNG bytes (base64) via the 3-tier ladder: grim foreign-toplevel (background-safe) → headless-output → focused-region (visible, background_safe=false). Report which rung + full honesty metadata. Refuse rather than return blank. Producer output is capped at 8 MiB and is read through a bounded, size-verified stream before encoding.

Compositor control (dispatcher-grammar correct — auto-detect 0.55 string vs 0.56+ `hl.dsp.*` Lua grammar via an `hl.dsp.no_op()` probe; env override `OMAHARNESS_DISPATCH_API`-style)
- `focus` `{ address | name }` → focus a window.
- `workspace` `{ id | name }` → switch workspace.
- (No `exec` here — the helper stays scoped to desktop control, not arbitrary process launch. OMP already provides native Bash; the helper's value is the GUI/Wayland/accessibility reach a shell lacks, with honesty metadata and lock-safe routing.)

Safety
- Mutating ops (input, ax_perform/set, focus, workspace) refuse when the session is locked (check `hyprctl`/`logind`; fail closed if unknown).
- `fcntl` transaction locking serializes snapshot/restore (focused-region capture) so concurrent calls can't interleave; report a focus-restore race rather than yanking the cursor.

## TS integration

`ghost_desktop` (packages/extensions/src/extensions/hyprland.ts, renamed/expanded):
one enum-action tool — `state | see | layers | focus | workspace | key | type
| click | drag | scroll | mouse_move | ax_query | ax_roles | ax_perform |
ax_set | hit_test | notify`. `ax_*` + `hit_test` are the semantic path;
`key/type/click/drag/scroll/mouse_move` the coordinate path. Structured errors;
execFile arg arrays; no shell interpolation of model input.

`ghost_screen`: uses `capture` (ladder + honesty), returns the image natively
to a vision-capable model — a text-only model reaches it through OMP's
`inspect_image` or its attachment describe-fallback instead — and surfaces
`background_safe`/`warnings` to the model so it knows whether the shot
disturbed the desktop. `mode: "watch"` loops the same `capture` op N times over
an interval and returns the frames as an **image sequence** (multiple image
blocks to a vision model; the saved paths + an `inspect_image` instruction to a
text-only one) — the ghost's "video understanding", since models have no native
video input. Zero new dependency; bounded by a frame cap and a wall-clock
budget, still exclusive-concurrency serialized.

Helper discovery: the daemon locates/starts the sidecar (like it does nothing
today — the extension spawns it lazily, one per daemon, reused); if PyGObject
/ grim / wtype are missing, tools degrade with a clear "install X" error and
the doctor reports it.
