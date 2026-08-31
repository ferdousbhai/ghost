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
  components/          chat, ask, work strip, tool-card, routing and orb UI
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

The HUD follows the daemon's interaction model. A model selection closes the
switcher immediately and returns focus to chat. The advanced routing view binds
all of Ghost's model roles, shows whether each primary is explicit or which
effective model Auto resolves, and edits the complete ordered retry chain.
General and Research remain available only for older homes that configured
them. Within each provider, current model families sort ahead of older versions.

`Connect a model` opens the provider login panel rather than changing routing
silently. The panel offers each provider's supported OAuth or API-key path:
OAuth may open an authorization URL, accept the returned code, and ask for a
provider choice; API-key login accepts the pasted key. Completion returns to
chat, while login opened from the switcher returns there. The switcher itself
closes on a model selection and restores chat focus.

Ghost's `ask` tool appears as a structured in-chat form, taking the composer's
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
the HUD. No harness-owned toast is shown.

Dismissal is not a nicety. Until it existed, a question the user did not want to
answer had no exit but closing the app, which left the conversation holding a
question and no way to answer it. A settled ask keeps a card in the transcript
carrying the question, the options offered, and how it actually ended — answered,
never answered, timed out, or talked through instead, from the transcript's
`ghostAsk.settled`. An unanswered one wears the rose that failure wears, and
offers to answer it now on the branch the daemon kept. While a model is
streaming, Esc requests a stop and keeps any composer draft. The composer
accepts the next message only after ghostd acknowledges that the old runtime
turn and its persistence boundary have released. Shift+Enter inserts a newline.

The chat column also carries a conversation-scoped background-job strip above
the composer, with cancellation and bounded output disclosure. It disappears
when no jobs exist and polls running jobs only while the HUD is visible.

A project bound before the first owner turn is still an unpublished draft. The
shell keeps that runtime-qualified identity selected while it asks ghostd to
abandon the draft before New conversation, another ghost, or another stored
conversation replaces it; a failed abandon leaves the current draft intact and
the same owner action retries it. Published conversations never use this draft
operation. This protection covers the active in-memory draft identity: the
shell does not persist a separate registry of unpublished draft IDs, and an
unpublished binding is intentionally absent from the conversation listing, so
a shell process restart cannot rediscover one by scanning project paths.

A reply is the answer, not an account of how it was reached. Which tools ran is
narrated by the activity line while it happens and then leaves: a settled turn
shows only the calls a reader still needs — the ones that failed, and `ask`,
whose card carries the re-answer branch — behind a quiet "3 steps" toggle that
restores the full trail. Those traces are unchanged: purpose while active,
outcome when one is available, implementation details only when expanded. User
messages expose a hover-revealed edit action that forks a new conversation and
returns that text to the composer; ghost replies keep their copy action beside
the final text line. There is no sibling navigator: the fork is another thread
in the sidebar. Historical ask cards can still be re-answered to create a
sibling branch and resume generation from it.

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
Harnesses, Character, Memory, Commands, Hooks, MCP, Remote, and Phone access stay
reachable without covering the content.

The ghost-scoped context response remains derived rather than persisted. It
contains character and read-only atomic memory. Custom agent definitions remain
preview-only in the principal; coding delegation uses the native `claude-code`,
`codex`, and `pi` harness boundary. Memory deletion is confirmed and recoverable.
Character and agent-definition deletion are not offered.

Harnesses is the owner-facing view of that task boundary. It shows installed
harness availability and Omarchy's current usage snapshots, then lists the
selected ghost's durable coding tasks with assignment, progress, result, and
workspace review artifacts. Follow-up messages and cancellation target the
daemon-owned native session. New tasks still begin through conversation so the
Ghost chooses the harness and trusted cwd; the pane never pushes, opens a pull
request, merges, or deletes a review branch.

Commands is the effective, conversation-scoped Ghost slash-command catalog:
headless builtins, admitted Markdown commands and prompt templates, and
explicit `/skill:<name>` entries, exactly as the daemon reports them.
It is searchable by name, alias, description, input, and source. Choosing a row
returns to chat with `/name ` staged in the composer; it never runs on selection.
Typing `/` in the composer opens the same catalog as a compact autocomplete.
Commands known from other harnesses that Ghost supports only partially (or not at all)
remain discoverable with an availability badge and reason; selecting one still
only stages text, so the palette never suggests that staging proved support.

MCP manages only the selected ghost's visible `<ghost-home>/mcp.json`: list,
add, replace, enable/disable, and delete. An explicitly bound external project
may separately contribute native `.omp/mcp.json` or legacy `.omp/.mcp.json` to
that conversation, but this ghost-level manager never adopts or writes those
files. The daemon's catalog is sanitized before it reaches QML. Command
arguments, environment/header values, authentication references, OAuth
settings, and URL query values are never displayed. Safe placement and policy
fields (`cwd`, `envPolicy`, and `headerPolicy`) remain visible so a replacement
edit can preserve them. Add and edit use a full JSON configuration editor;
replacing a server that has hidden fields is blocked until the owner confirms
those values were re-entered. Deletion always uses a modal confirmation.

Remote collects only the capabilities which cross the local machine boundary.
Live voice is scoped to the active conversation, uses the machine microphone
and OpenAI Codex Realtime with the ghost's Codex OAuth, and shows the current
phase, mute state, audio levels, and any transcript returned by the daemon.
The legacy collaboration controls remain as compatibility UI and render their
structured `not_supported` response as a neutral product-status explanation;
Ghost plans no encrypted collaboration relay.

Phone access is the machine-global sibling to that conversation-scoped Remote
view. “Reach me from my phone” asks ghostd to enable or disable Tailscale Serve,
then shows its private tailnet URL, a camera-sized QR code, the owner identity,
and the read-only guest policy. Setup problems carry the daemon's exact message;
when one has a one-time terminal command, the panel keeps it selectable and
offers a keyboard-accessible copy action. The panel refreshes when opened and
after a switch change, but does not poll in the background.
For problem-state previews, pass
`--remote-problem=tailscale_missing` (or another daemon problem code) to the
mock, or set `GHOST_REMOTE_PROBLEM`.

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
qs -c ghost ipc call ghost section memory     # chat|character|memory|commands|hooks|mcp|connect|remote
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

## If something is wrong

The daemon logs to the journal (`journalctl --user -u ghostd -f`). For the shell,
run it from a terminal and watch stderr; QML type errors and failed bindings
print there. Reproduce against the mock with `dev/preview.sh` rather than
debugging on the live desktop.
