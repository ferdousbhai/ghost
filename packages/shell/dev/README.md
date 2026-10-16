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
`~/.config/omarchy/plugins/ferdousbhai.ghost` may point at a different install.
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
# Shape a preview: --slow (30ms deltas), --tool-steps N,
# --fail (turn ends in an error), --omit-terminal (no terminal event),
# --stall-stream (stream never settles),
# --stop-hook S (a stop hook decides for S seconds after each reply),
# --cut-bytes N (cut each turn response after N bytes, as ghostd does at ~1 MB).

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
  bottom, and the Chat / Board / Character / Hooks / MCP / Remote access
  rail floating at the right edge. `SUPER+CTRL+G` is
  launch-or-focus: reveal+focus when hidden/unfocused, hide only when already
  focused. Character edits `character.md`. Hooks shows the
  owner's `hooks.json` handlers with their lifecycle triggers and the loaded
  count, and opening it does not create a conversation. MCP lists stdio, HTTP,
  and SSE fixtures as stored and exercises add, full replacement,
  enable/disable, and confirmed deletion. Remote exercises the Tailscale viewer lifecycle, including the
  off, on, and `--remote-problem` states.
  The mock's temporary ghost fixtures make every pane live without touching
  `~/ghosts`.
- On `ask`: the spectral summoning orb naming the tool call it is inside of,
  then the reply arriving word by word with `**bold**` rendered as bold. The
  narration stays as its own message, its tool call settled behind that
  message's quiet "1 step" toggle rather than in a card of its own, and the
  reply arrives as the next message.
- A finished turn or failure raises a desktop toast unless
  its conversation is being viewed in the focused chat panel. Clicking the toast
  opens that conversation; subsequent toasts replace it while it remains live.
- `Esc` cancels a running turn (nothing when idle — a normal window is not
  dismissed with Esc; use `SUPER+CTRL+G`).
- `hyprctl clients -j` lists it as a real toplevel — it is NOT in
  `hyprctl layers`. A plugin window carries the host shell's app-id, so match it
  on title (`^Ghost( — .*)?$`), not on class. `SHIFT+SUPER+<n>` moves it between workspaces.

`dev/evidence/ghost-hud.png` is a nested-preview capture of the HUD against
the mock, opened on `casper`.

## Validation

```sh
pnpm --filter @ghost/omarchy lint     # qmllint over every QML file
```

With the preview's private environment exported and its window visible, run
the native focus regression from `packages/shell`:

```sh
quickshell -p "$PWD/focus-probe.qml"
```

It opens two windows inside the nested compositor and checks focused Chat,
unfocused Chat, and focused Board. It refuses a non-preview runtime or live port.
Unlike a mocked compositor title, Qt's own window focus reflects actual input
focus even when Hyprland's client cache has not populated its title.

`qmllint` needs the `qs.*` modules Quickshell synthesises at runtime resolved
by hand, which is what the `.qmllint/qs -> ../qml` symlink and `-I .qmllint`
are for. Use `/usr/lib/qt6/bin/qmllint`, never `/usr/bin/qmllint` — on Arch the
latter is a **Qt 5 stub that exits 0 on any input**, including files with
misspelled properties.

### Expected warnings

None. Treat QML import and signal warnings as findings; a missing service import
can prevent notifications from loading even when the panel itself opens.

## Manual verification

Use this preview for changes involving focus, layout, notifications, or file
writes; mocked unit tests alone cannot prove those behaviors. Check the
surfaces affected by the change:

- Focused Chat marks replies read; Board, unfocused Chat, and a narrow
  workbench hiding Chat preserve unread state.
- Resources open on demand and add no chat messages.
- Notifications replace their prior server ID and open the originating
  conversation when clicked.
- File edits preserve Markdown, merge disjoint external edits, and block
  close/switch on conflicts or failed saves. Include an empty external file
  and recovery after a permission-denied save.
- The bar widget fills its host slot; hover, exit, and clicks use host APIs.
- Test theme changes and multiple outputs in an isolated environment when
  the change affects them; do not infer coverage from a single-output run.

Record results with the change being reviewed, rather than accumulating dated
validation claims here.
