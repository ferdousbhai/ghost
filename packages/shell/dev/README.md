# Developing the ghost shell

No daemon or models needed. `mock-ghostd.mjs` implements enough of the
CONTRACTS.md API to build and demo every surface.

## Isolated HUD preview — the required verification path

Development previews must **not** run directly on the owner's desktop.
Enabling this plugin in the live `omarchy-shell` puts a mock-backed ghost
beside the real one, and a crash or syntax error in the plugin takes the
owner's whole desktop shell down with it.

`preview.sh` runs a nested Hyprland **and a nested omarchy-shell** with a
private HOME, seeds this checkout's plugin into that HOME's
`~/.config/omarchy/plugins/`, and summons it over shell IPC. The isolation
stops at the runtime boundary, not the source tree: the plugin is symlinked in
place, not copied, and the owner's own
`~/.config/omarchy/plugins/ferdousbhai.ghost` is a symlink to a checkout too.
Editing that checkout does **not** hot-reload the owner's live HUD — a running
omarchy-shell keeps the QML it already loaded, and neither a save, a
`rescanPlugins`, nor `omarchy plugin disable`+`enable` replaces it (see
AGENTS.md). That cuts both ways: a bad edit will not take down the live shell,
and a good one does not reach it either, so a change is only live after
`omarchy-restart-shell`. Prefer passing `preview.sh` a scratch copy when a
change is experimental; copying by default would make the preview stop
following the source it is meant to verify.

Start the mock on any non-7717 port, then give that already-running port to
`preview.sh`:

```sh
cd packages/shell

# Terminal 1: two ghosts, owned temporary context, and canned streamed replies.
node dev/mock-ghostd.mjs --port 17717
# Shape a preview: --slow (30ms deltas), --tool-steps N, --ask-timeout S,
# --fail (turn ends in an error), --omit-terminal (no terminal event),
# --stall-stream (stream never settles).

# Terminal 2: the one supported HUD preview command.
bash dev/preview.sh qml 17717
# Equivalently: GHOSTD_PORT=17717 bash dev/preview.sh qml
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
omarchy-shell ghost section hooks
omarchy-shell ghost ask "who lives here?"

# Hyprland 0.56 requires Lua dispatcher expressions.
hyprctl dispatch 'hl.dsp.focus({ window = "title:^Ghost( — .*)?$" })'
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
  bash dev/preview.sh qml 17717
```

Press Ctrl-C in the preview terminal to tear down everything it started, then
stop the mock separately.

### What you should see

- **The component maps nothing until `open`.** The HUD is a `FloatingWindow`
  bound to `visible: false`; `preview.sh` calls the IPC `open` method after the
  isolated shell is ready.
- On `open`: a 998×620 window that Hyprland tiles into the
  layout like any app. The HUD uses a neutral reading canvas with the current
  Omarchy accent and semantic status colours. Roster on the left (`casper`,
  `moaning-myrtle`, `+ new ghost`), transcript in the middle, composer at the
  bottom, and the permanent Chat / Character / Commands / Hooks / MCP / Board /
  Remote access rail at the right edge. `SUPER+CTRL+G` is
  launch-or-focus: reveal+focus when hidden/unfocused, hide only when already
  focused. Character edits `character.md`.
  Commands shows the session's searchable Ghost catalog and stages a chosen slash
  command in chat; typing `/` opens its compact
  autocomplete, including clear partial/unsupported labels. Hooks shows the
  daemon-global redacted catalog: bounded labels, lifecycle triggers, idle
  timing, and the loaded count. It never returns hook commands, paths, prompts,
  or injected context, and opening it does not create a conversation. MCP lists
  sanitized stdio, HTTP, and SSE fixtures and exercises add, full replacement,
  enable/disable, and confirmed deletion without ever returning the seeded
  secret values. Remote exercises the Tailscale viewer lifecycle, including the
  off, on, and `--remote-problem` states. `--relay-pairing 482913` starts with
  a browser waiting for Allow, so the pairing prompt is on screen.
  The mock's temporary ghost fixtures make every pane live without touching
  `~/ghosts`.
- On `ask`: the spectral summoning orb naming the tool call it is inside of,
  then the reply arriving word by word with `**bold**` rendered as bold. The
  narration never reaches the transcript, and the tool call settles behind the
  row's quiet "1 step" toggle rather than into a card of its own.
- With the HUD closed, a finished turn raises a `notify-send` notification
  instead.
- `Esc` cancels a running turn (nothing when idle — a normal window is not
  dismissed with Esc; use `SUPER+CTRL+G`).
- `hyprctl clients -j` lists it as a real toplevel — it is NOT in
  `hyprctl layers`. A plugin window carries the host shell's app-id, so match it
  on title (`^Ghost( — .*)?$`), not on class. `SHIFT+SUPER+<n>` moves it between workspaces.

`dev/evidence/ghost-hud.png` is a capture of the HUD (from its earlier
layer-shell incarnation; the card contents are unchanged).

## Validation

```sh
pnpm --filter @ghost/omarchy lint     # qmllint over every QML file
```

`qmllint` needs the `qs.*` modules Quickshell synthesises at runtime resolved
by hand, which is what the `.qmllint/qs -> ../qml` symlink and `-I .qmllint`
are for. Use `/usr/lib/qt6/bin/qmllint`, never `/usr/bin/qmllint` — on Arch the
latter is a **Qt 5 stub that exits 0 on any input**, including files with
misspelled properties.

### Expected warnings

One, an unused-import info on `Service.qml`. The three `PanelWindow` warnings
documented here previously belonged to `GhostBarSurface.qml`, deleted when the
HUD became an omarchy-shell plugin. Anything beyond the one info line is a real
finding.

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
- **The "Connect a model" panel** (`ModelLogin.qml`) against the mock's login
  endpoints: the provider picker, the OAuth auth-URL + paste-code step, the
  `select` step, and the api-key step, each rendered live and captured under
  `dev/evidence/model-login*.png`. Driven by `ipc call ghost login` /
  `loginTo <id> <authType>`.
- **The bar widget in the owner's own bar**, after `omarchy-restart-shell`:
  `omarchy-shell shell debugBarGeometry` reports it filling a 27x26 host slot
  level with its neighbours.

Not verified live:

- **Theme switching.** The `theme.name` watch is reasoned from
  `omarchy-theme-set`'s implementation (`rm -rf` + `mv`, then `echo >
  theme.name`), not observed — switching themes would have restyled the
  developer's whole desktop.
- **Multi-monitor.** One output here. As a normal toplevel the HUD is placed by
  Hyprland on the focused workspace, and `focuswindow class:ghost` (the "focus"
  half of launch-or-focus) pulls an already-open window across outputs — neither
  path was exercised against a second monitor.
- `notify-send` output was raised but its rendering was not inspected.
