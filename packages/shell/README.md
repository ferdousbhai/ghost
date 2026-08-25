# @ghost/shell

Omarchy-native desktop surfaces for `ghostd`, built with
[Quickshell](https://quickshell.org) (QML).

The chat HUD is a normal application window — a Quickshell `FloatingWindow`
(xdg-toplevel), app-id `ghost` — so Hyprland tiles it, resizes it, and moves it
between workspaces with its own binds, exactly like any app. `SUPER+CTRL+G` is
launch-or-focus, not an overlay toggle. The persistent chrome around it stays in
the layer/tray world: the bar widget is a wlr-layer surface and the tray icon is
a StatusNotifierItem, both alive for as long as the shell runs and wearing
whatever theme the desktop wears.

```
qml/
  shell.qml            entry point: surfaces, IPC, notification wiring, AppId
  GhostHud.qml         the chat window (FloatingWindow / xdg-toplevel)
  GhostBarWidget.qml   status dot + ghost name, embeddable
  GhostBarSurface.qml  opt-in standalone layer strip carrying the widget
  TrayBridge.qml       system-tray (StatusNotifierItem) presence, via a helper
  tray/ghost-tray.py   the SNI + DBusMenu D-Bus object Quickshell cannot expose
  components/          chat, ask, queue, tool-card, routing and orb UI
  services/            Ghostd, Theme, Notifier (singletons)     → qs.services
contrib/               keybinds, systemd unit, Omarchy bar integration
dev/                   mock daemon, demo script, lint
```

Install steps live in [`contrib/README.md`](contrib/README.md); development and
what was verified how live in [`dev/README.md`](dev/README.md).

## The three decisions worth knowing

**SSE without a helper process.** Qt's QML `XMLHttpRequest` fires
`onreadystatechange` repeatedly at `readyState 3`, once per network chunk, and
exposes the cumulative body in `responseText` — measured here for both GET and
POST before any UI existed. So `Ghostd` streams pi-messages directly: track a
consumed offset, buffer the trailing partial frame, parse `data:` lines. No
`Process` running `curl -N`, no line-parser plumbing. Two things the pattern
demands: `responseText` is cumulative (never treat a `readyState 3` body as a
delta), and the request object must be held in a property or it can be
collected mid-flight.

**One process, one client.** The HUD and the bar widget share a single `Ghostd`
singleton, so the bar dot reflects live turn state with no polling and no
second connection to the daemon. The one place that cannot work is inside
*Omarchy's* bar, which is a different process — see `contrib/README.md` for
that trade.

**A normal window, not a layer surface.** The HUD is a `FloatingWindow`, so it
is a real xdg-toplevel: `hyprctl clients` lists it, the WM tiles and resizes it,
and `SHIFT+SUPER+<n>` moves it between workspaces — no custom screen-move code.
Its app-id is set process-wide by `//@ pragma AppId ghost` (an *instance*
pragma, so it must live in `shell.qml`), which is the class Hyprland exposes for
`windowrule`s. `SUPER+CTRL+G` (`toggle`) is launch-or-focus: reveal+focus when hidden
or unfocused, hide only when already focused. It replaced an earlier layer-shell
HUD whose `HyprlandFocusGrab` and custom `moveNext` monitor-move IPC existed only
because a layer surface is invisible to the WM's own window binds.

## Harness interaction

The HUD follows modern OMP's interaction model. A model selection closes the
switcher immediately and returns focus to chat. The advanced routing view binds
all of OMP's built-in roles, shows whether each primary is explicit or which
effective model Auto resolves, and edits the complete ordered retry chain.
General and Research remain available only for older homes that configured
them. Within each provider, current model families sort ahead of older versions.

`Connect a model` opens the provider login panel rather than changing routing
silently. The panel offers each provider's supported OAuth or API-key path:
OAuth may open an authorization URL, accept the returned code, and ask for a
provider choice; API-key login accepts the pasted key. Completion returns to
chat, while login opened from the switcher returns there. The switcher itself
closes on a model selection and restores chat focus.

OMP's built-in `ask` appears as a structured in-chat form, taking the composer's
place while a question stands. It supports offered options, custom input, notes,
multiple selection, chat-about-this, and dismissal; it is separate from tool
approval, which Ghost does not expose. Because it replaces the composer, it also
takes the keyboard: Enter answers, Esc dismisses from anywhere, number keys pick
options, arrows move through them, and Tab reaches the free-text field. The
recommended option starts selected, so Enter alone agrees with what the daemon
would submit if the ask timed out. Answering or dismissing hands focus back.
When the HUD is shut, a completed turn keeps the active ghost's name and an
excerpt of its answer. If a turn pauses instead, Ghost raises the actual
question under that same identity; clicking either Omarchy notification opens
the HUD. OMP's hard-coded "Oh My Pi / Waiting for input" toast stays disabled.

Dismissal is not a nicety. Until it existed, a question the user did not want to
answer had no exit but closing the app, which left the conversation holding a
question and no way to answer it. A settled ask keeps a card in the transcript
carrying the question, the options offered, and how it actually ended — answered,
never answered, timed out, or talked through instead, from the transcript's
`ghostAsk.settled`. An unanswered one wears the rose that failure wears, and
offers to answer it now on the branch the daemon kept. While a model
is streaming, Enter steers the active run, Ctrl+Enter queues a follow-up, and
Shift+Enter inserts a newline. The queued state is visible below the composer.

A reply is the answer, not an account of how it was reached. Which tools ran is
narrated by the activity line while it happens and then leaves: a settled turn
shows only the calls a reader still needs — the ones that failed, and `ask`,
whose card carries the re-answer branch — behind a quiet "3 steps" toggle that
restores the full trail. Those traces are unchanged: purpose while active,
outcome when one is available, implementation details only when expanded. User
messages expose editable branch points and sibling navigation; historical ask
cards can be re-answered to create a sibling branch and resume generation from
it.

The activity line uses the recovered summon-ghost spectral orb and rotating,
tool-aware summoning copy. The QML port traces to summon-ghost commit
`be07ca78c95fe38dae105866f7543283f483443b` (the mature glow-clipping fix).
Its aura is deliberately unclipped, the line keeps a stable height, and motion
can be disabled with `GHOST_REDUCE_MOTION=1`.

It also carries the ghost's own narration. A model that opens a turn with
"Checking your Dropbox for the invoice" before reaching for a tool is reporting
status, not replying, so that line goes beside the orb rather than into the
reading column, and the spectral phrases fill the silences instead.
`qml/services/TurnBlocks.js` makes the call, with no classifier: a text block
only becomes a preamble because a tool call came after it, and that is
structural. A block long enough to be a section of a multi-step answer stays in
the reply whatever follows it. Live and restored transcripts run the same split,
so a reload does not resurrect what streaming set aside.

## Context navigation

The restored 64px rail at the right edge is the successor to summon-ghost's
final `AppSideNav` (`4852804cf4e09ca50c16e08e6106c06df82e2a94`): Chat,
Docs, Memory, Helpers, Commands, MCP, Remote, and Character stay reachable without covering the
content. Docs follows that version's Train layout — a document index on the
left and the existing lossless markdown editor on the right — but deliberately
omits Train's adjacent chat panel and Ghost's roster/conversation sidebar.

The daemon derives one authenticated context response from the live ghost home
and OMP agent discovery whenever the surface opens or refreshes. It is never
persisted. Docs and character remain real editable files; memory is shown
read-only as atomic facts; helpers expose capability metadata but not their
source paths. Documents and memory facts can be deleted only through explicit
confirmation, and the daemon moves the underlying file to system Trash. An
open document editor is synchronously flushed and closed before deletion, so a
late autosave cannot recreate the file. Character and helper deletion are not
offered.

Docs are `docs/**/*.md` in canonical `ghost-home/v2` form: byte 0 is a
non-empty `# Title`, and the optional final nonblank line is only lowercase
hyphenated hashtag slugs (`#[a-z0-9]+(?:-[a-z0-9]+)*`). `#archived` removes a
document from the default working set. The heading and tags stay in the raw
Markdown; documents have no YAML frontmatter. The one-time migration first
renames an unambiguous `notes/` directory to `docs/`, then atomically rewrites
legacy files (first H1, then legacy `title`, then filename; slugified legacy
tags; `archived: true` as `#archived`; merged trailing tags; discarded import
`path`). It is idempotent after a partial run and keeps no marker or dual-format
reader. New writes are v2 only.
The document pane edits Markdown source in a monospace `TextEdit`, preserving
exactly the bytes typed. Its `Reading` view is a read-only Markdown rendering;
links open externally and rendering never serializes back into the file. Edits
autosave atomically after an 800ms debounce, and closing, hiding, or switching
files flushes first.
If the file changes underneath a dirty buffer, the shell
tries a line-based three-way merge; a clean merge autosaves silently, while a
real conflict pauses autosave until the owner keeps either side. The daemon
writer validates the complete v2 body and writes exactly that body.

Commands is the effective, conversation-scoped OMP slash-command catalog:
built-ins, extension/plugin commands, project commands, and explicit
`/skill:<name>` entries use the same discovery and precedence as the harness.
It is searchable by name, alias, description, input, and source. Choosing a row
returns to chat with `/name ` staged in the composer; it never runs on selection.
Typing `/` in the composer opens the same catalog as a compact autocomplete.
Commands that OMP exposes but Ghost supports only partially (or not at all)
remain discoverable with an availability badge and reason; selecting one still
only stages text, so the palette never suggests that staging proved support.

MCP manages only the selected ghost's project-owned `.omp/mcp.json` (and the
legacy `.omp/.mcp.json` when it owns an existing row): list, add, replace,
enable/disable, and delete. The daemon's catalog is sanitized before it reaches
QML. Command arguments, environment/header values, authentication references,
OAuth settings, and URL query values are never displayed. Safe placement and
policy fields (`cwd`, `envPolicy`, and `headerPolicy`) remain visible so a
replacement edit can preserve them. Add and edit use a full JSON configuration
editor; replacing a server that has hidden fields is blocked until the owner
confirms those values were re-entered. Deletion always uses a modal confirmation.

Remote collects only the capabilities which cross the local machine boundary.
Live voice is scoped to the active conversation, uses the machine microphone
and OpenAI Codex Realtime with the ghost's Codex OAuth, and shows the current
phase, mute state, audio levels, and any transcript returned by the daemon.
Collaboration is conversation-scoped encrypted relay collaboration with
visibly distinct read-only and writable URLs. Read-only can start directly;
writable access requires typing `WRITABLE` after a warning that its holder can
steer the ghost and exercise local tools. A structured `not_supported` response
renders as a neutral product-status explanation.

## System tray

The ghost also shows up as a system-tray icon — a StatusNotifierItem — for as
long as the shell is running: a ghost glyph tinted to the theme (dim when idle,
accent while streaming, red when `ghostd` is unreachable), tooltip'd with the
active ghost's name, left-click to toggle the HUD, and a DBusMenu with a ghost
radio list when there is more than one, the active ghost's five most recent
conversations (unread ones lead with `•`), "New conversation", "Choose a
model", and "Quit ghost shell".

Quickshell 0.3.0 can *consume* an SNI (`Quickshell.Services.SystemTray`) but
exposes nothing to *produce* one — no generic D-Bus object or bus-name API
anywhere in its QML surface. So the D-Bus object lives in a tiny helper,
`tray/ghost-tray.py` (dbus-python + GLib), which `TrayBridge.qml` spawns as a
child of the shell: it is alive exactly when the shell is, no watcher needed.
The shell pushes live `Ghostd`/`Theme` state down the helper's stdin and the
helper pushes clicks back up its stdout, so there is still one `Ghostd` client
and every ghost decision stays in QML. See `dev/README.md` for what was proven
against a live tray.

## Theming

Reads Omarchy's active theme from
`~/.local/state/omarchy/current/theme/colors.toml` (colours, `mode`) and
`shell.toml` (bar sizing and optional technical font), and re-reads on theme switch by watching
`theme.name` — the one file that survives `omarchy-theme-set`'s
`rm -rf theme/ && mv next-theme/ theme/`.

The compact bar and tray continue to wear the desktop palette. The reading HUD
uses a Scandinavian neutral canvas and system sans-serif type, then carries in
one Omarchy accent for focus/current state plus the theme's semantic status
colours. Its text, chrome, hover, and selected-state ladders are deliberately
separate, so a decorative theme `muted` colour can never become low-contrast
body copy. Without Omarchy, the remaining accent and status roles fall back to
Tokyo Night values, so every surface still runs on bare Hyprland.

## IPC

```sh
ghost-launch open|toggle
qs -c ghost ipc call ghost toggle
qs -c ghost ipc call ghost open|close
qs -c ghost ipc call ghost summon <name>
qs -c ghost ipc call ghost ask "<prompt>"     # reply arrives as a notification
qs -c ghost ipc call ghost login              # open "Connect a model"
qs -c ghost ipc call ghost loginTo <id> <oauth|api_key>   # and start one
qs -c ghost ipc call ghost switcher           # open the model switcher
qs -c ghost ipc call ghost section docs       # chat|docs|memory|agents|commands|mcp|connect|character
qs -c ghost ipc call ghost status             # JSON
qs -c ghost ipc call ghost refresh            # re-read roster and theme
```

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `GHOSTD_HOST` | `127.0.0.1` | daemon host (loopback only) |
| `GHOSTD_PORT` | `7717` | daemon port |
| `GHOSTD_API_TOKEN_FILE` | `$XDG_STATE_HOME/ghost/api-token` | the `0600` file holding the API bearer token the daemon mints at startup; `Ghostd.qml` reads it and sends `Authorization: Bearer …` on every request, re-reading once on a `401` so `ghostd api-token --rotate` does not need a shell restart |
| `GHOST_BAR_SURFACE` | unset | `1` puts up the standalone bar strip |
| `GHOST_HUD_REPLAY` | unset | `1` replays local history in every request instead of relying on `options.sessionId` |
| `GHOST_REDUCE_MOTION` | unset | `1`, `true`, or `yes` keeps the spectral orb and activity copy static |

## Status

The daemon is real now: `ghostd` is built, dogfooded, and runs as a systemd
user service. `dev/mock-ghostd.mjs` is a development harness — it implements
enough of the CONTRACTS.md API to build and demo every surface without the
daemon, pi, or a model — not a stand-in for something that does not exist. The
client assumes the daemon owns conversation history, keyed by
`options.sessionId`; set `GHOST_HUD_REPLAY=1` if a build turns out to be
stateless per request.
