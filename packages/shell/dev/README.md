# Developing the ghost shell

No daemon, no OMP, no models needed. `mock-ghostd.mjs` implements enough of the
CONTRACTS.md API to build and demo every surface.

## Files and document contract

The mock fixtures use `ghost-home/v2`: each `docs/**/*.md` starts at byte 0
with a non-empty `# Title`, and may end with one nonblank line containing only
lowercase hashtag slugs matching `#[a-z0-9]+(?:-[a-z0-9]+)*`. `#archived` is
reserved and removes a document from the default working set. Title and tags
are raw Markdown, not YAML frontmatter.

Import and daemon startup run the one-time migration from `ghost-home/v1` after
renaming an unambiguous `notes/` directory to `docs/`. The migration chooses a
legacy title by first H1, then frontmatter `title`, then filename; slugifies
legacy tags, turns `archived: true` into `#archived`, merges and deduplicates
trailing hashtags, discards the import-only `path`, and atomically rewrites each
file. It is safe to rerun after interruption, keeps no marker, and leaves no
dual-format reader. This mock starts with v2 fixtures and does not emulate the
legacy format.

## Demo script

Four terminals' worth of commands, in order. Nothing here touches your running
Omarchy shell — the ghost config is a *separate* Quickshell process launched by
path.

```sh
cd packages/shell

# 1. The fake daemon. Two ghosts, canned context files in an owned temporary
#    root, and a streamed reply with one tool call.
node dev/mock-ghostd.mjs            # add --slow to watch deltas land
                                    #     --fail to end the next turn in an error

# 2. The shell, isolated. Never `qs` with no arguments — that would load the
#    user's default config.
quickshell -p qml/shell.qml

# 3. Drive it.
qs -p qml/shell.qml ipc show                      # the IPC surface
qs -p qml/shell.qml ipc call ghost status         # JSON state
qs -p qml/shell.qml ipc call ghost open
qs -p qml/shell.qml ipc call ghost section docs
qs -p qml/shell.qml ipc call ghost section memory
qs -p qml/shell.qml ipc call ghost section agents
qs -p qml/shell.qml ipc call ghost section commands
qs -p qml/shell.qml ipc call ghost section mcp
qs -p qml/shell.qml ipc call ghost section connect
qs -p qml/shell.qml ipc call ghost section character
qs -p qml/shell.qml ipc call ghost ask "who lives here?"
qs -p qml/shell.qml ipc call ghost close

# 4. Stop.
qs -p qml/shell.qml kill
```

### What you should see

- **Nothing on screen until `open`.** The HUD is a `FloatingWindow` bound to
  `visible: false`; loading the config maps no window. This makes almost all of
  the shell testable without putting anything over the developer's desktop.
- On `open`: a 998×620 window (app-id `ghost`) that Hyprland tiles into the
  layout like any app. The HUD uses a neutral reading canvas with the current
  Omarchy accent and semantic status colours. Roster on the left (`casper`,
  `moaning-myrtle`, `+ new ghost`), transcript in the middle, composer at the
bottom, and the permanent Chat / Docs / Memory / Helpers / Commands / MCP / Remote / Character rail at
  the right edge. `SUPER+CTRL+G` is launch-or-focus: reveal+focus when
  hidden/unfocused, hide only when already focused.
  `section docs` shows the Train-style file index and v2 documents. The editor
  has a lossless monospace source view and a read-only Markdown Reading view;
  switching views never rewrites the document. Typing autosaves the complete
  body atomically, while closing or switching files flushes first. An external
  change is merged line-by-line when safe and otherwise pauses autosave for an
  explicit keep-mine/take-theirs choice. The daemon's writer validates and
  writes exactly the complete v2 body. Memory is read-only, Helpers describes
  OMP subagents, and Character edits `character.md`. Docs and memory rows offer
  confirmed, recoverable deletion; the mock moves its owned fixture into a
  temporary mock Trash. Commands shows the session's searchable OMP catalog and
  stages a chosen slash command in chat; typing `/` opens its compact
  autocomplete, including clear partial/unsupported labels. MCP lists
  sanitized stdio, HTTP, and SSE fixtures and exercises add, full replacement,
  enable/disable, and confirmed deletion without ever returning the seeded
  secret values. Remote exercises the OpenAI live-voice lifecycle and
  encrypted collaboration with distinct read-only/writable relay links.
  `moaning-myrtle` deliberately returns structured `not_supported` for
  collaboration so that state is demoable too.
  The mock's temporary fixture makes every pane live without
  touching `~/Ghosts`.
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
  Summon / per-ghost radio / Choose-a-model / Quit tree; a synthesised
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
