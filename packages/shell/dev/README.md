# Developing the ghost shell

No daemon, no OMP, no models needed. `mock-ghostd.mjs` implements enough of the
CONTRACTS.md API to build and demo every surface.

## Isolated HUD preview — the required verification path

Development previews must **not** run directly on the owner's desktop. A plain
`quickshell -p …` joins the live session bus, registers a second tray icon, and
puts a mock-backed ghost beside the real one. The duplicate tray item and mock
ghost are easy to mistake for owner state.

The isolation stops at the runtime boundary, not the source tree. `preview.sh`
resolves the supplied config path and loads that QML in place; it does not copy
the tree. Independently, `~/.config/quickshell/ghost` is a symlink to this
checkout's `packages/shell/qml/`, so the nested preview isolates what the
preview displays but cannot isolate the owner's running shell from edits to the
QML that shell loads. An agent editing `packages/shell/qml/` during a
verification run hot-reloads the owner's HUD underneath the run and
re-registers its tray helper. A crash or syntax error in that QML takes the
owner's live shell down with it. Know that boundary before editing; prefer
passing `preview.sh` a scratch copy when a change is experimental. Copying by
default would make the preview stop following the source it is meant to verify
without removing the separate hazard created by the owner's symlink.

Start the mock on any non-7717 port, then give that already-running port to
`preview.sh`:

```sh
cd packages/shell

# Terminal 1: two ghosts, owned temporary context, and canned streamed replies.
node dev/mock-ghostd.mjs --port 17717
# Shape a preview: --slow (30ms deltas), --tool-steps N, --ask-timeout S,
# --fail (turn ends in an error), --omit-terminal (no terminal event),
# --stall-stream (stream never settles), --no-jobs (return no background jobs).

# Terminal 2: the one supported HUD preview command.
bash dev/preview.sh qml/shell.qml 17717
# Equivalently: GHOSTD_PORT=17717 bash dev/preview.sh qml/shell.qml
```

The script rejects port 7717 explicitly and refuses a daemon roster beneath the
owner's real ghost root. It gives the preview a private HOME, XDG tree, Wayland
runtime, Hyprland instance, and D-Bus session, launches Quickshell inside the
nested compositor, then opens the HUD. `EXIT`, `INT`, and `TERM` all run the same
cleanup: Quickshell and nested-Hyprland process groups, their helpers, the
private bus, IPC sockets, Wayland socket, and temporary files are removed. The
already-running mock is intentionally not owned by the preview script.

The ready message prints `XDG_RUNTIME_DIR`, `WAYLAND_DISPLAY`, and
`HYPRLAND_INSTANCE_SIGNATURE`. Export those three values in another terminal to
drive that exact nested instance:

```sh
qs -p qml/shell.qml ipc call ghost section memory
qs -p qml/shell.qml ipc call ghost ask "who lives here?"

# Hyprland 0.56 requires Lua dispatcher expressions.
hyprctl dispatch 'hl.dsp.focus({ window = "class:ghost" })'
hyprctl dispatch 'hl.dsp.exec_cmd("notify-send preview")'
```

The expensive trap: on Hyprland 0.56, legacy plain-syntax calls such as
`hyprctl dispatch exec …` are silent no-ops. Use the quoted `hl.dsp.…`
expression form above (and the printed instance signature), which does execute
inside the nested compositor.

Capture screenshots with `grim` under those same exported nested variables:

```sh
grim /tmp/ghost-hud.png
```

For a single reproducible capture, the supervisor can run `grim` itself after
the HUD settles:

```sh
GHOST_PREVIEW_SCREENSHOT=/tmp/ghost-hud.png \
  bash dev/preview.sh qml/shell.qml 17717
```

Press Ctrl-C in the preview terminal to tear down everything it started, then
stop the mock separately.

### What you should see

- **The component maps nothing until `open`.** The HUD is a `FloatingWindow`
  bound to `visible: false`; `preview.sh` calls the IPC `open` method after the
  isolated shell is ready.
- On `open`: a 998×620 window (app-id `ghost`) that Hyprland tiles into the
  layout like any app. The HUD uses a neutral reading canvas with the current
  Omarchy accent and semantic status colours. Roster on the left (`casper`,
  `moaning-myrtle`, `+ new ghost`), transcript in the middle, composer at the
  bottom, and the permanent Chat / Harnesses / Character / Memory / Hooks /
  MCP / Remote / Phone access rail at the right edge. `SUPER+CTRL+G` is
  launch-or-focus: reveal+focus when
  hidden/unfocused, hide only when already focused.
  Harnesses shows Claude Code, Codex, and Pi capacity plus the active
  ghost's durable task list. Selecting a task exposes its literal assignment,
  progress, result, worktree/branch review state, follow-up input, and cancel
  control; task creation remains in chat. Character edits `character.md`.
  Memory is read-only and its rows offer confirmed, recoverable deletion.
  Hooks shows the daemon-global redacted catalog: bounded labels, lifecycle triggers, idle
  timing, and the loaded count. It never returns hook commands, paths, prompts,
  or injected context, and opening it does not create a conversation. MCP lists
  sanitized stdio, HTTP, and SSE fixtures and exercises add, full replacement,
  enable/disable, and confirmed deletion without ever returning the seeded
  secret values. Remote exercises the OpenAI live-voice lifecycle and the
  legacy collaboration compatibility UI, including distinct read-only/writable
  mock links and a structured `not_supported` state. Those links are
  fixture-only; shipped remote sharing uses the Tailscale viewer.
  The mock's temporary ghost fixtures make every pane live without touching
  `~/ghosts`.
- On `ask`: the spectral summoning orb saying "Checking what I remember about
  that" in the ghost's own words rather than a spectral phrase, then the reply
  arriving word by word with `**bold**` rendered as bold. The narration never
  reaches the transcript, and the `read_memory` call it announced settles behind
  the row's quiet "1 step" toggle rather than into a card of its own.
- With the HUD closed, a finished turn raises a `notify-send` notification
  instead.
- `Esc` cancels a running turn (nothing when idle — a normal window is not
  dismissed with Esc; use `SUPER+CTRL+G` or the tray).
- `hyprctl clients -j` lists it as a real toplevel with `class: "ghost"` — it is
  NOT in `hyprctl layers`. `SHIFT+SUPER+<n>` moves it between workspaces.

`dev/evidence/ghost-hud.png` is a capture of the HUD (from its earlier
layer-shell incarnation; the card contents are unchanged).

## Validation

```sh
pnpm --filter @ghost/shell lint     # qmllint over every QML file
```

`qmllint` needs the `qs.*` modules Quickshell synthesises at runtime resolved
by hand, which is what the `.qmllint/qs -> ../qml` symlink and `-I .qmllint`
are for. Use `/usr/lib/qt6/bin/qmllint`, never `/usr/bin/qmllint` — on Arch the
latter is a **Qt 5 stub that exits 0 on any input**, including files with
misspelled properties.

### Expected warnings

Three, all on `GhostBarSurface.qml` — the one remaining `PanelWindow` — and all
artifacts of how Quickshell registers its types rather than problems in this
code:

```
Type PanelWindow is not creatable.           [uncreatable-type]
unknown grouped property scope margins.      [unqualified]
Type margins is used but it is not resolved  [unresolved-type]
```

`PanelWindow` is registered `isCreatable: false` because Quickshell substitutes
the platform backend (`WlrLayershell`) at runtime — its own docs say
"`PanelWindow` in particular cannot be resolved". The `margins` value type is
exported from `Quickshell` while `PanelWindowInterface` lives in
`Quickshell._Window`, which does not depend on it; `anchors` on the same type
resolves fine. `FloatingWindow` (the HUD) is a creatable type and raises none of
these. Anything beyond these three is a real finding.

## What was verified live, and what was not

Verified on this machine (Omarchy 4.0.0.alpha, Hyprland 0.56.2, Quickshell
0.3.0, Qt 6.11.2):

- Streaming `XMLHttpRequest` — `readyState 3` fires once per network chunk for
  both GET and POST, with cumulative `responseText`. Measured headlessly
  against a chunked SSE server before any UI existed.
- Config load with zero QML errors; `qs ipc show`/`call`/`prop get`.
- A full turn end to end against the mock: roster fetch, POST, SSE parse, tool
  activity, markdown render, terminal `done`, notification.
- The HUD surface under Hyprland: layer, geometry (`hyprctl layers`), theme
  colours, focus grab, Esc.
- `contrib/omarchy/scripts/ghost-bar-status` against a live and a dead shell.
- **The "Connect a model" panel** (`ModelLogin.qml`) against the mock's login
  endpoints: the provider picker, the OAuth auth-URL + paste-code step, the
  `select` step, and the api-key step, each rendered live and captured under
  `dev/evidence/model-login*.png`. Driven by `ipc call ghost login` /
  `loginTo <id> <authType>`.
- **The system-tray item** (`TrayBridge.qml` + `tray/ghost-tray.py`). Registered
  against this machine's live `org.kde.StatusNotifierWatcher` (the one hosting
  the Omarchy bar's tray). Verified by `gdbus`: the item appears in
  `RegisteredStatusNotifierItems`; `org.kde.StatusNotifierItem` `GetAll` returns
  `Id=ghost`, `Status=Active`, `ItemIsMenu=false`, `Menu=/MenuBar`, and a
  status-tinted `IconPixmap`; `com.canonical.dbusmenu` `GetLayout` returns the
  conditional ghost radio list / five recent conversations / New conversation /
  Choose-a-model / Quit-ghost-shell tree; a synthesised
  `Activate` emitted `{"action":"toggle"}` and, end to end, opened the ghost HUD
  window (against the layer-shell HUD of the time; the seam is unchanged). The
  three status glyphs the helper draws
  are captured at `dev/evidence/tray-glyph-{idle,streaming,unreachable}.png` and
  the live bar at `dev/evidence/tray-bar.png`. `Qt.quit()` was confirmed to
  terminate a Quickshell process (the Quit menu entry's action).

Not verified live:

- **A full streamed turn against the real `ghostd`.** `ghostd` now exists and
  runs as a systemd user service; the tray helper's shell connected to it and
  read the roster live. But the streaming turn path here was exercised only
  against the mock, which follows the pi-messages event union but cannot prove
  the daemon emits it. First integration risk: whether the daemon owns
  conversation history via `options.sessionId` (what this client assumes) or
  expects the full `context` replayed (set `GHOST_HUD_REPLAY=1` if so).
- **The tray icon rendered inline in Omarchy's bar.** The item registers and the
  bar (its SNI host) accepts it, but omarchy-bar collapses tray items into an
  expandable group, so a freshly-registered `Active` item lands behind the bar's
  `<` overflow toggle rather than inline — same as several stock items. Which
  items show inline is omarchy-bar's own config, not something the SNI item
  controls.
- **The Omarchy bar module in Omarchy's bar.** Installing it would mean editing
  the developer's live `shell.json` and reloading their desktop shell. It is
  written against the documented contract in
  `/usr/share/omarchy/shell/plugins/bar/README.md` and lints clean standalone.
- **Theme switching.** The `theme.name` watch is reasoned from
  `omarchy-theme-set`'s implementation (`rm -rf` + `mv`, then `echo >
  theme.name`), not observed — switching themes would have restyled the
  developer's whole desktop.
- **Multi-monitor.** One output here. As a normal toplevel the HUD is placed by
  Hyprland on the focused workspace, and `focuswindow class:ghost` (the "focus"
  half of launch-or-focus) pulls an already-open window across outputs — neither
  path was exercised against a second monitor.
- `notify-send` output was raised but its rendering was not inspected.
