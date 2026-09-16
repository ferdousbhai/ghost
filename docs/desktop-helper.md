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
extensions shell to this sidecar.

Vision is NOT in the helper. Once the helper fallback is needed, semantic
(AT-SPI) access is preferred where it exists (GTK); a screenshot read by the
chat model is the universal fallback for canvas/Qt-without-a11y/web/games. The
strongest path uses both: try semantic, fall back to a screenshot + vision.

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
malformed handshake/response is `invalid_format`. The TS client re-codes what
the sidecar returns onto that same vocabulary: `capability` becomes
`not_found`, everything else `invalid_format`.

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

`protocol.py` is the argument list; it validates every field and is the only
place the exact shapes are written down. What each group guarantees:

**Windows / desktop state** — `see`, `state`, `layers`, `toplevels`. Read-only
views of Hyprland clients, workspaces, layer surfaces, and the
`ext-foreign-toplevel-list-v1` list that says what is background-capturable.

**Accessibility (AT-SPI)** — `ax_query`, `ax_roles`, `ax_perform`, `ax_set`,
`hit_test`. A unified GTK3/4 role vocabulary: an unknown role is refused with
the valid ones listed, never guessed. `hit_test` resolves a screen coordinate
to the element under it and mints a fresh `ref`, closing the
screenshot -> coordinate -> semantic-ref loop; it refuses rather than guesses
when no node offers trustworthy bounds.

**Input (layout-safe)** — `key`, `type`, `click`, `drag`, `scroll`,
`mouse_move`. Semantic paths first (AT-SPI action, `hyprctl sendshortcut`,
`wtype`), falling back to `ydotool` with a layout-unsafe warning. `drag`
interpolates waypoints so canvas targets see the motion. `scroll` is never
background-safe — it moves on-screen content. `mouse_move` leaves the pointer
where it put it; every other pointer op restores it.

**Capture** — `capture` over a window, a screen, or a region. A window goes
through the 3-tier ladder: grim foreign-toplevel (background-safe) ->
headless-output -> focused-region (visible, `background_safe=false`). Screen and
region deliberately bypass the router, reading already-composited pixels with
`grim -o` / `grim -g` without selecting, focusing, or moving anything; region
capture warns that occluded content is absent. A result carries
`model_png_base64` plus `model_width`/`model_height`/`model_scale` when the
capture was scaled for the model (`model_image.py`) — to the monitor's logical
size, so image coordinates *are* the desktop coordinates input ops take, and
within a 1568 px long edge. `png_base64` is always the full capture.

**Compositor control** — `focus`, `workspace`. Dispatcher-grammar correct: an
`hl.dsp.no_op()` probe picks `legacy-string` (pre-0.56) or `lua-table` (0.56+),
and `OMAHARNESS_DISPATCH_API` overrides it. There is deliberately no `exec`:
the helper is desktop control, and the runtime owns shell execution.

Every path reports full honesty metadata, refuses blank output, and bounds the
producer PNG to 8 MiB through a size-verified stream before encoding.

Safety
- Every mutating op (`key`, `type`, `click`, `drag`, `scroll`, `mouse_move`,
  `ax_perform`, `ax_set`, `focus`, `workspace`) refuses when the session is
  locked — and when neither Hyprland nor logind can say whether it is, so the
  unknown case fails closed. `hit_test` is a read, like `ax_query`.
- The one path that must temporarily change compositor state (focused-region
  capture, injected input) takes a single-writer `fcntl` lock under
  `$XDG_RUNTIME_DIR`, snapshots focus/workspace/cursor, works, restores, and
  reports the interference. Concurrent calls cannot interleave their
  snapshot/restore windows, and an owner who moved the pointer mid-flight gets
  a reported race rather than a yanked cursor.

## TS integration

`ghost_desktop` (packages/extensions/src/extensions/hyprland.ts):
one enum-action tool — `state | see | layers | focus | workspace | key | type
| click | drag | scroll | mouse_move | ax_query | ax_roles | ax_perform |
ax_set | hit_test | notify`. `ax_*` + `hit_test` are the semantic path;
`key/type/click/drag/scroll/mouse_move` the coordinate path. Structured errors;
execFile arg arrays; no shell interpolation of model input.

`ghost_screen`: uses `capture` (ladder + honesty), returns the image natively
to a vision-capable model (the logical-size `model_png_base64` copy when the
helper made one; the saved file keeps every pixel) — a text-only model is told
the capture is not attached, which is what pi says, and gets the saved path —
and surfaces
`background_safe`/`warnings` to the model so it knows whether the shot
disturbed the desktop. `mode: "watch"` loops the same `capture` op N times over
an interval and returns the frames as an **image sequence** (multiple image
blocks to a vision model; the saved paths to a text-only one) — the ghost's "video understanding", since models have no native
video input. Zero new dependency; bounded by a frame cap and a wall-clock
budget, and serialized against every other capture by the process-wide chain
in `screen.ts`.

Helper discovery: the extension spawns the sidecar lazily, one per daemon,
reused across calls; if PyGObject / grim / wtype are missing, tools degrade
with a clear "install X" error and `hello` reports it.
