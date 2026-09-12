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
(we have our own browser relay). Our TS `ghost_desktop`/`ghost_screen`
extensions shell to this sidecar — the same shape as `TrayBridge.qml` →
`ghost-tray.py`.

Vision is NOT in the helper. Once the helper fallback is needed, semantic
(AT-SPI) access is preferred where it exists (GTK); Ghost's `inspect_image` —
which resolves the `advisor_model` role Ghost binds from `models.json` — is the
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

The handshake carries desktop-helper protocol version `2`, pinned by
`DESKTOP_HELPER_PROTOCOL_VERSION` in the [Python sidecar](../packages/desktop-helper/src/ghost_desktop_helper/protocol.py)
and [TypeScript client](../packages/extensions/src/extensions/desktop-helper-client.ts).
A missing or different version stops the sidecar before any request is sent and
asks the owner to reinstall/update Ghost so `ghostd` and
`ghost-desktop-helper` come from the same build.

The unsolicited startup `hello` and explicit `hello` op are the complete
diagnostic boundary: their `in_hyprland_session`, Hyprland version/grammar, and
`available-backends` fields report degraded capabilities with reasons. There is
no separate `doctor` alias.

Request:  `{ "id": <n>, "op": "<name>", "args": { ... } }`
Response: `{ "id": <n>, "ok": true, "result": { ... } }`
       |  `{ "id": <n>, "ok": false, "error": { "code": "...", "message": "...", "details": {} } }`

Client errors retain the requested `op`. An unavailable helper/pipe is
`not_found`, a deadline or line-size ceiling is `limit_exceeded`, and a
malformed handshake/response is `invalid_format`.

The sidecar's own `error.code` vocabulary, which the TS client and the model
must both handle:

| code | meaning |
| --- | --- |
| `unknown_ref` | A stale or never-minted element ref (`details.reason` says which). |
| `capability` | A backend is missing, refused, or the session is locked; the message carries the remediation. |
| `ambiguous_target` | More than one window matched the `app` selector. |
| `state_restore` | The op ran but focus/workspace restoration failed afterward. |
| `invalid_args` | A malformed argument value. |
| `harness` | Any other desktop-craft failure. |
| `internal` | An unexpected error inside the helper. |
| `unknown_op` | An op outside the advertised set. |
| `invalid_json`, `invalid_request` | A line that is not JSON / not an object (no `id`). |

Every capture/input/perform result carries **honesty metadata** (from the
harness's model): `{ backend, background_safe, interference: [...], warnings:
[...] }`. Never return a blank/faked result — refuse with a clear error and
say why.

## Ops

Windows / desktop state
- `see` `{ name? }` → windows matching (address, title, class, workspace, geometry, focused).
- `state` → condensed clients + workspaces + activewindow (the same shape `ghost_desktop` state returns, sourced here).
- `layers` → wlr-layer-shell surfaces with logical geometry + scale.
- `toplevels` → `ext-foreign-toplevel-list-v1` list (background-capturable).

Accessibility (AT-SPI)
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
- `capture` `{ target: "window", name?, address? }` → PNG bytes (base64) via the 3-tier window ladder: grim foreign-toplevel (background-safe) → headless-output → focused-region (visible, background_safe=false). Every capture result also carries `model_png_base64` with `model_width`/`model_height`/`model_scale` when the capture was scaled for the model (`model_image.py`): to the monitor's logical size (physical ÷ scale, so image coordinates are the desktop coordinates input ops take) and within a 1568 px long edge, where vision providers downsample anyway. `png_base64` is always the full capture, and the field is absent when nothing changed.
- `capture` `{ target: "screen", output? }` and `{ target: "region", region }` deliberately bypass the window router: direct `grim -o` / `grim -g` reads already-composited pixels without selecting, focusing, or moving a window. Results identify `grim-output` / `grim-region`; region capture warns that occluded content is absent.

Every path reports full honesty metadata, refuses blank output, and bounds the
producer PNG to 8 MiB through a size-verified stream before encoding.

Compositor control (dispatcher-grammar correct — auto-detect 0.55 string vs 0.56+ `hl.dsp.*` Lua grammar via an `hl.dsp.no_op()` probe; env override `OMAHARNESS_DISPATCH_API`-style)
- `focus` `{ address | name }` → focus a window.
- `workspace` `{ id | name }` → switch workspace.
- (No `exec` here — the helper stays scoped to desktop control, not arbitrary
  process launch. The principal runtime owns shell execution: each runtime
  keeps its own native Bash. The
  helper's value is the GUI/Wayland/accessibility reach either shell lacks,
  with honesty metadata and lock-safe routing.)

Safety
- Mutating ops (input, ax_perform/set, focus, workspace) refuse when the session is locked (check `hyprctl`/`logind`; fail closed if unknown).
- `fcntl` transaction locking serializes snapshot/restore (focused-region capture) so concurrent calls can't interleave; report a focus-restore race rather than yanking the cursor.

## TS integration

`ghost_desktop` (packages/extensions/src/extensions/hyprland.ts):
one enum-action tool — `state | see | layers | focus | workspace | key | type
| click | drag | scroll | mouse_move | ax_query | ax_roles | ax_perform |
ax_set | hit_test | notify`. `ax_*` + `hit_test` are the semantic path;
`key/type/click/drag/scroll/mouse_move` the coordinate path. Structured errors;
execFile arg arrays; no shell interpolation of model input.

`ghost_screen`: uses `capture` (ladder + honesty), returns the image natively
to a vision-capable model (the logical-size `model_png_base64` copy when the
helper made one; the saved file keeps every pixel) — a text-only model reaches it through Ghost's
`inspect_image`, which uses the bound `advisor_model` — and surfaces
`background_safe`/`warnings` to the model so it knows whether the shot
disturbed the desktop. `mode: "watch"` loops the same `capture` op N times over
an interval and returns the frames as an **image sequence** (multiple image
blocks to a vision model; the saved paths + an `inspect_image` instruction to a
text-only one) — the ghost's "video understanding", since models have no native
video input. Zero new dependency; bounded by a frame cap and a wall-clock
budget, and serialized against every other capture by the process-wide chain
in `screen.ts`.

Helper discovery: the extension spawns the sidecar lazily, one per daemon,
reused across calls; if PyGObject / grim / wtype are missing, tools degrade
with a clear "install X" error and `hello` reports it.
