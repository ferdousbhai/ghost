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
# --tool-error (the first tool call fails),
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

The ready message names an env file holding the whole private environment
(home, XDG dirs, runtime dir, D-Bus bus, mock port, and the nested Wayland and
Hyprland instance). Source it in another terminal to drive that exact nested
instance:

```sh
omarchy-shell ghost section hooks
omarchy-shell ghost ask "who lives here?"

# Hyprland 0.56 requires Lua dispatcher expressions.
hyprctl dispatch 'hl.dsp.exec_cmd("notify-send preview")'
```

The expensive trap: on Hyprland 0.56, legacy plain-syntax calls such as
`hyprctl dispatch exec …` are silent no-ops. Use the quoted `hl.dsp.…`
expression form above (and the printed instance signature), which does execute
inside the nested compositor.

`GHOST_PREVIEW_VOXTYPE=1 bash dev/preview.sh qml 17717` adds a private
Voxtype daemon for the presence's voice path. Its state, lock and socket stay
in the preview's runtime dir; it types only with `wtype` into the nested
compositor, pauses no media, and links the owner's installed model rather than
downloading one. It does record the owner's real microphone while the prompt
listens, which is the point: speak to check a transcript reaches the prompt.

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

Press Ctrl-C in the preview terminal, or send `TERM` to the PID the ready
message prints, to tear down everything it started; then stop the mock
separately. Use that printed PID rather than `$!` from a `setsid` launch:
`setsid` forks when its caller leads a process group, so `$!` names a parent
that has already exited and the preview keeps running.

### What you should see

- **The component maps nothing until `open`.** The HUD is a layer surface
  bound to `visible: false`; `preview.sh` calls the IPC `summon` method after the
  isolated shell is ready.
- On `open`: the takeover, a `ghost-hud` layer covering the nested monitor
  with the desktop dimmed round a centred surface. The HUD uses a neutral reading canvas with the current
  Omarchy accent and semantic status colours. Roster on the left (`casper`,
  `moaning-myrtle`; `+` in its Ghosts header), transcript in the middle, composer at the
  bottom, and the Chat / Board / Routines / Character / Hooks / MCP / Remote access
  rail floating at the right edge. `preview.sh` summons it with
  `{"section":"chat"}`; a plain summon opens the presence instead (below).
  The nested session binds no keys (the summon key would reach the owner's
  own HUD); drive the preview with `omarchy-shell shell toggle ferdousbhai.ghost`
  under the exported variables.
  Character edits `character.md`. Hooks shows the
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
- On a plain toggle with the takeover closed: four `ghost-presence` edge layers
  and a full-screen `ghost-presence-prompt` layer in `hyprctl layers`, the
  prompt focused (`wtype` types into it under the exported variables). `Enter`
  replaces the prompt with a `ghost-presence-card` ticker over 10px edges; the
  reply then fills the card with no toast. A second toggle shows
  `continuing`; `Esc` or a second toggle closes the prompt and removes its
  layer. Without Voxtype the mic stays hidden; with `GHOST_PREVIEW_VOXTYPE=1`
  (below) the summon sets the private `$XDG_RUNTIME_DIR/voxtype/state` to
  `recording` while the owner's stays `idle`, Esc returns it to `idle`, and
  Enter on an empty prompt goes `transcribing`, then sends what was heard or,
  hearing nothing, leaves the prompt waiting.
- A finished turn or failure raises a desktop toast unless
  its conversation is being viewed in the focused chat panel or followed by
  the presence. Clicking the toast
  opens that conversation; subsequent toasts replace it while it remains live.
- `Esc` behaves as getting-started's key table says: it leaves the takeover
  last, after a question and the workbench, and a running turn survives it.
- `hyprctl layers` lists `ghost-hud` while it is up; `hyprctl clients` lists
  nothing of Ghost's. A backdrop click closes it.


## Validation

```sh
pnpm --filter @ghost/omarchy lint     # qmllint over every QML file under qml/
```

Use `/usr/lib/qt6/bin/qmllint`, never `/usr/bin/qmllint` — on Arch the
latter is a **Qt 5 stub that exits 0 on any input**, including files with
misspelled properties.

### Expected warnings

None. Treat QML import and signal warnings as findings; a missing service import
can prevent notifications from loading even when the panel itself opens.

## Manual verification

Use this preview for changes involving focus, layout, notifications, or file
writes; mocked unit tests alone cannot prove those behaviors. Check the
surfaces affected by the change:

- Chat in the takeover and the presence card mark replies read; Board, a
  closed takeover, and a narrow workbench hiding Chat preserve unread state.
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
