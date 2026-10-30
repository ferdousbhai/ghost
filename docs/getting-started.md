# Getting started

Install Ghost, create a persona, and talk in the HUD or terminal.

For what the pieces *are*, read [concepts.md](concepts.md) after — or instead
of — this page.

## 0. What you need

- **Omarchy** (Hyprland + Quickshell). Ghost depends on that desktop shape;
  there is no generic Arch/Hyprland support promise.
- **Bun 1.3.14+** at runtime, plus the rest of the package's dependencies —
  pacman installs them with the package.
- **An agent CLI** — Omarchy installs Claude Code, Codex, Grok, Copilot,
  OpenCode, pi, and others, and a ghost's turns run on them, on your own
  subscriptions. With none yet, OpenCode answers on its free models with no
  sign-in; sign into any other the way you normally would (`claude`,
  `codex login`, …) and it joins in.

## 1. Install the package

Open the Omarchy menu, then **Install → AI → Ghost**. Until that entry ships
([#54](https://github.com/ferdousbhai/ghost/issues/54)), install the `ghost`
package from Omarchy's repository; `omarchy update` keeps it current:

```sh
omarchy pkg add ghost
```

Omarchy's repository takes a few hours or more to carry a new release. To
install the latest release now, run this as yourself:

```sh
curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash
```

It installs from Omarchy's repository when that already has the latest
release, and otherwise builds Omarchy's own recipe for it; either way the
packages are the same, and `omarchy update` keeps them current afterwards.
It also starts Ghost for your login (section 3).

For checkout development, use the
[rolling package recipe](../packaging/arch/README.md). Install matching runtime
and UI packages together; a workspace build alone does not update the app.

The package only puts files in place; section 3 starts Ghost for this login.

If `omarchy update` fails on `ghost.db`, this machine still has the
self-hosted `[ghost]` repository that installs from before Omarchy shipped
Ghost added. Its releases are gone; remove it:

```sh
sudo sed -i '\#^Include = /etc/pacman.d/ghost.conf$#d' /etc/pacman.conf
sudo rm -f /etc/pacman.d/ghost.conf
rm -f ~/.config/omarchy/hooks/pre-refresh-pacman.d/ghost
```

### Product skills through Bash

Nothing to install: every conversation already has Ghost's product index,
[`skills/ghost-products`](../skills/ghost-products/SKILL.md). It lists the
recommended products; the ghost installs a product when needed, and the product installs its own skill
(`<cli> skill install`). Ghost uses
these product CLIs through the harness's Bash/shell tool and native skill
discovery; no additional daemon integration or MCP server is needed.

Each skill explains how to detect and install its missing CLI and use existing
accounts. The owner completes sign-in windows and keeps passwords/recovery keys
out of chat. Installing a package does not authorize sending messages, changing
mail routing, or restoring/syncing files.

Start a fresh harness session after installing a skill. For ghost-specific
skills, link them under `~/ghosts/<name>/skills/`; Ghost exposes that directory
as project skills in each conversation. Source checkouts are never loaded into
a conversation automatically. No daemon restart is needed.

## 2. Where shared notes go

Nothing to install. Your XDG Documents directory (`xdg-user-dir DOCUMENTS`,
usually `~/Documents`) is the owner-shared scope: every ghost reads and writes
it with its harness's native file tools, its own notes included, kept in
your existing project and topic folders. Ghost does not index the directory
or read any of it until a request calls for it. For search by meaning, a
ghost can offer to install Recall, which indexes only the folders you choose.

### Bring your own UI

For a remote desktop with an app-provided UI, install `ghost-runtime` instead of
`ghost`. It includes the daemon/API, CLI, `ghost-desktop`, and a Bash browser skill,
without Ghost's HUD, launcher, icons, or Quickshell dependency. Start only
`ghostd.service`; the graphical-session and authentication requirements below
still apply. See [runtime install and UI removal](../packaging/arch/README.md#runtime-with-your-own-ui).

## 3. Confirm setup

The Install → AI → Ghost entry starts the daemon and links and enables the
HUD. After `omarchy pkg add ghost`, do the same for this login:

```sh
systemctl --user enable --now ghostd.service
mkdir -p ~/.config/omarchy/plugins
ln -sfnT /usr/share/ghost/plugin ~/.config/omarchy/plugins/ferdousbhai.ghost
omarchy-shell shell rescanPlugins
omarchy plugin enable ferdousbhai.ghost
```

The rescan finishes in the background; if `omarchy plugin enable` doesn't
find the plugin yet, run it again. Runtime-only installs need just the first
line.

`ghostd.service` is `PartOf=graphical-session.target`: it comes up with your
compositor and dies with it, and binds `127.0.0.1:7717`. The HUD is not a unit
— it is a plugin inside your own `omarchy-shell`, summoned with
`omarchy-shell shell toggle ferdousbhai.ghost`; history and settings open with
`omarchy-shell ghost section home`.

Confirm the client can reach and authenticate to the daemon:

```sh
ghost status
```

It prints the daemon URL, `reachable yes`, `authenticated yes`, the token file
path, the ghost count, and remote-access state. The bearer token is minted on
first run at `~/.local/state/ghost/api-token` (mode 0600); the HUD and CLI read
that file themselves, and `ghostd api-token` prints it for curl or debugging.
To replace it, delete the file and `systemctl --user restart ghostd`.

**Summon key.** `SUPER+CTRL+G` summons the ghost as soon as the shell loads
the plugin: Ghost asks Hyprland for the binding at runtime, so nothing in
`~/.config/hypr` or `~/.config/omarchy` is edited. If one of your own bindings
already holds that key for something else, Ghost leaves it alone and says so in
the shell's log; bind another key with a snippet from
`/usr/share/doc/ghost/shell-contrib/`
(`hyprland/ghost.lua` for Omarchy 4's Lua config), or summon with
`omarchy-shell shell toggle ferdousbhai.ghost`. A Hyprland still on a `.conf`
config cannot run what Ghost asks for at runtime: source `hyprland/ghost.conf`,
which carries the key and the window rule the prompt and history need.

The summon prompt and history are windows that float over everything, so a
habitual `SUPER+W` closes Ghost rather than the app behind it, while your other
shortcuts (screenshots, volume, workspaces) keep working. `Esc` closes the
prompt; in the history it steps back first, and the `×` closes it.

## 4. Create a ghost

Terminal:

```sh
ghost new sage
ghost use sage        # save it as your default ghost (~/.config/ghost/cli.json)
ghost list
```

HUD: open the ghost mark in the bar, choose **Ghosts**, type a name, and press
Enter on **Summon sage**. The same list switches ghosts (Enter), renames one
(`Ctrl+R`), and banishes one (`Delete`, then type its name to confirm).

Either route posts to the same daemon route, which creates `~/ghosts/sage/`
with a seeded `character.md`.
Names are 1–64 characters of letters, digits, `.`, `_`, or `-`, starting with
a letter or digit. The directory name *is* the ghost's name.

While `character.md` is still the seed, the ghost knows it has not met you: it
helps with what you asked first, learns about you in the gaps, and offers a
character draft for your approval before writing itself. Nothing is blocked
waiting for that.

## 5. Which agent answers

Nothing to configure: each turn runs on one of the agent CLIs you already use,
headless, in the conversation's own directory under the ghost home. Ghost
picks, per turn, the one already carrying the conversation, then the ghost's
`harness` setting, then your Omarchy default agent (`omarchy default agent
<name>`), then any other installed agent:

```sh
ghost harnesses          # installed agents and informational usage
```

Open **Resources…** from the harness menu to inspect the latest successful
run. It separates instructions and MCP toolsets supplied by Ghost from the
skills, plugins, tools, and other resources reported by the harness. Missing
categories are omitted; availability does not prove content entered context.
The tailnet viewer has the same on-demand view, and `ghost show --resources`
prints it in the terminal. Resources never appear as chat messages.
See [agent coverage](run-resources.md). The MCP navbar editor manages the
additional servers configured for this ghost, not the harness's own settings.

In the HUD, the harness label beside the conversation title opens a picker:
choose an agent for this conversation, then "use <agent>" makes it the ghost's
default for new conversations and "automatic" sets that back. From the terminal, or by asking the ghost, which runs the
same commands:

```sh
ghost harness            # which agent this ghost prefers
ghost harness codex      # prefer codex for this ghost (--none: automatic)
ghost switch claude      # run this conversation's next turn on claude
```

A switched conversation's new agent is handed the conversation so far. The
preference lives in the ghost's `settings.yml` as `harness: codex`.

An agent that fails before replying or starting a tool hands the turn to the
next, with the conversation so far. A later failure ends the turn with an error. The model, sign-in, tools,
and permissions are that agent's own, configured as you would for yourself;
Ghost has no model picker or provider login. For the hard questions, a ghost
also delegates from Bash to a specialist (`ghost delegate claude -- -p …`).

## 6. First conversation

Press `SUPER+CTRL+G` (or run `omarchy-shell shell toggle ferdousbhai.ghost`).
The screen edges glow and a prompt opens near the bottom of the focused
monitor, already listening if Voxtype is installed. Speak or type, then press
`Enter`; with nothing typed, `Enter` stops the recording and sends what was
heard. `Tab` picks another ghost, and `Esc` or a click outside closes the
prompt.

The prompt closes and the ghost works in the background: a thin shimmer stays
on the edges and a ticker says what it is doing. Its reply replaces the
ticker as a card. Summon again while the card is up to follow up in the same
conversation (`new ×` starts a fresh one instead); `×` or `Esc` on the card
dismisses it, and `open` shows the conversation in history.

Clicking the ghost in the bar opens history the same way: the edges light
from the mark, and it is already listening. Speak to fill the search, then
press `Enter` to ask the ghost what you said, or type and use the arrows to
pick a conversation (the arrows stop the listening, so `Enter` opens it).

History and settings open the way your desktop's own menu does (the ghost
mark in the Omarchy bar, your app launcher, or
`omarchy-shell ghost section home`): a card over whatever is open, with a
filter on top and the ghost's conversations and places under it.

| Key | Effect |
|---|---|
| typing | filter conversations and places |
| `Up` / `Down` (`Ctrl+K` / `Ctrl+J`) | move |
| `Enter` | open the row; with nothing matching, ask the ghost what you typed |
| `Tab` | the next ghost's list |
| `Ctrl+N` | new conversation |
| `Ctrl+R` / `Ctrl+P` / `Delete` | rename, pin, or trash the selected conversation |
| `Esc` | close |

A row grows the card into its view: a conversation, **Board**, **Routines**,
**Character**, **Hooks**, **MCP servers**, or **Remote access**; `‹` or `Esc`
goes back to the list. **Ghosts** stays a list of the same size. An empty conversation shows the ghost's
glyph, its name, and the static line `What's on your mind?`.

In a conversation, type, and:

| Key | Effect |
|---|---|
| `Enter` | send |
| `Shift+Enter` | newline |
| `Enter` *(mid-turn)* | queue the text; it runs as soon as the current pass ends |
| `Esc` | dismiss a pending confirmation, then close the workbench, then back to the list; a running turn keeps going |
| `Shift+Esc` | stop a running turn |
| `Ctrl+N` | start a new conversation (the composer's `+`) |
| `PageUp` / `PageDown` | scroll the transcript a page |
| `Ctrl+Home` / `Ctrl+End` | jump to the transcript's start / back to its end, following new output again |
| `Ctrl+Shift+Up` / `Ctrl+Shift+Down` | jump to your previous / next message |

The transcript follows new output only while you are at its end. Scrolled
up, it stays put and shows **↓ Jump to latest message**; its scrollbar
appears only while it moves or under the pointer.

Clicking the ghost mark in the Omarchy bar toggles the card. The mark uses
herdr's colours: a green outline when everything is read, amber while the ghost
works, blue when a reply is unread, and red when it is waiting on you.

When the ghost needs a decision it asks with `ghost ask` instead of guessing:
the question shows on the presence card and above the composer with a few
suggested answers. Pick one (or press its number on the card), type any other
answer, or `dismiss` it.

## 7. The same ghost from the terminal

```sh
ghost say "What should I focus on today?"
ghost say --new "Start fresh"
ghost sessions
ghost show -s cli-abc
```

`ghost say` streams the turn; tool activity goes to stderr so stdout stays the
answer. It continues the most recently updated conversation unless you pass
`--new` or `-s <id>` (an id or any unique prefix). While a turn is running,
`--follow-up` queues text to run after it; a `--follow-up` to an idle
conversation becomes its next turn, which is how a ghost's own background
command reports back.

The CLI picks its ghost in this order: `-g/--ghost`, `$GHOST`, the default
saved by `ghost use`, then the sole installed ghost; the session is `-s`,
then `$GHOST_SESSION`, then the most recently updated one. A ghost's own shell
carries both variables. It never edits a ghost home directly: every change to
a ghost goes through the daemon, so the HUD sees everything it does
immediately, and the reverse.

`--json` gives you the raw API shape (one event object per line for streams),
`-q` drops secondary output, and `ghost help exit-codes` lists the stable exit
codes.

## 8. Where everything lives

| Path | What |
|---|---|
| `~/ghosts/<name>/` | the ghost home: `character.md`, `settings.yml`, `mcp.json`, and `sessions/<id>/`, one directory per conversation |
| `~/.config/ghost/config.json` | daemon config (port, host, ghosts root, remote owner, guests, and peers — `ghost help peers`) — optional; a missing file is fine, a malformed one is an error |
| `~/.config/ghost/hooks.json` | hook configuration, also editable from the HUD's Hooks pane |
| `~/.config/ghost/cli.json` | the `ghost use` default, private to your login |
| `~/.local/state/ghost/api-token` | the daemon bearer token |
| XDG Pictures | screenshots (desktop host contract; browser destinations chosen through Bash) |

`GHOSTS_ROOT` moves the ghosts root, `GHOSTD_CONFIG` the config file, and
`GHOSTD_API_TOKEN_FILE` the API token file.
`GHOSTD_HOST` and `GHOSTD_PORT` move the endpoint the daemon binds and the CLI
and HUD dial (`127.0.0.1:7717` by default; the daemon refuses a non-loopback
host).

Nothing in that list is owned by pacman. Upgrading or removing the package
leaves personas, conversations, tokens, your documents,
and any skill you installed untouched.

## 9. Optional, once you are talking

- **Use websites.** Install agent-browser and follow the shipped
  [web-browser skill](../skills/web-browser/SKILL.md) for signed-in Chromium
  setup, shared-session tab locking, and cleanup.
- **Talk instead of typing.** Install Omarchy's dictation (the Omarchy menu,
  Install → AI → Dictation, which sets up Voxtype). With the composer focused,
  hold `F9` and speak, or click the mic at the right of the composer; the
  composer says when it is listening, and `Esc` or its `×` discards the
  recording or transcription. A ghost can also transcribe an audio file with
  Voxtype (`ghost help dictation`). Ghost adds nothing else: no
  speech stack, no voice of its own.
- **Show it a picture.** Paste (`Ctrl+V`) or drop an image on the composer;
  it waits above the field, `×` to take it off, until you send.
- **Hooks.** [hooks.md](hooks.md); a ghost can write its own with `ghost hooks`.
- **Remote access.** `ghost remote` (or the HUD's Remote access pane)
  controls the opt-in Tailscale Serve viewer. Guests are read-only. On a
  phone, `+` starts a conversation and the camera attaches photos; dictate
  with the keyboard's own mic.

## 10. If something is wrong

| Symptom | Check |
|---|---|
| `cannot reach ghostd` / "ghostd is not answering" | `systemctl --user status ghostd.service`; `journalctl --user -u ghostd -e` |
| `unauthorized` (exit 4) | `ghostd api-token` as the machine owner; the HUD and CLI read `~/.local/state/ghost/api-token` |
| The HUD never appears | `omarchy plugin list` should show `ferdousbhai.ghost` enabled; if not, run the link, rescan, and enable lines in [Confirm setup](#3-confirm-setup). |
| A turn fails at once | `ghost harnesses` — is any supported agent installed? Run that agent by hand once to confirm it is signed in |
| You want a check that touches nothing | `ghost smoke --no-turn` runs a throwaway daemon on a free port against a temporary ghost home and reports each stage; drop `--no-turn` (and add `--harness <id>`) for a real two-turn check |

After an upgrade, restart the daemon to load the new bundle:

```sh
systemctl --user restart ghostd.service
omarchy-restart-shell
```

A rescan discovers a plugin; it does not replace QML the running shell has
already loaded, so an upgraded HUD needs the shell restart.

## Inspect scheduled work

Open **Routines** in the HUD or the tailnet owner viewer, or run:

```sh
ghost routines -g casper
ghost routines pause daily-notes -g casper
ghost routines resume daily-notes -g casper
ghost routines run daily-notes -g casper
```

The view reports the existing systemd user timers, their schedule, next trigger,
last service start, and latest service result when available. Pause disables
future triggers and leaves running work alone. Resume enables the timer;
persistent timers may catch up. Run now queues the service without changing the
timer and returns before the work finishes. Refresh to inspect its state.
Guests cannot inspect routines or control them.

Use **Edit sources** in the HUD or **Edit** on the phone to change the timer and
service together. Saves verify the units, detect source conflicts, reload
systemd, and keep a checkpoint. **Remove** also keeps a checkpoint. Recovery
entries restore the old source paused; resume explicitly when ready.

```sh
ghost routines config daily-notes -g casper > routine.json
# Edit timer/service in the JSON, preserving revision.
ghost routines edit daily-notes routine.json -g casper
ghost routines remove daily-notes -g casper
ghost routines recoveries -g casper
ghost routines restore <recovery-id> -g casper
ghost routines logs daily-notes -g casper
```

The editor supports regular same-name unit pairs without drop-ins. Use native
systemd tools for other arrangements. Checkpoints live under
`.ghost-routine-recovery/` beside the user units; native file tools can inspect
or move them to Trash. A stale checkpoint refuses to overwrite later edits.
The Logs action reads bounded service journal output and links conversations
named by event acceptance receipts. Journald remains the log store.

Create new units with `ghost help timers`. Connect selected external events
through `ghost help events` and [the external event guide](events.md).

## Machine heat and strain

To have a ghost woken before the machine gets into trouble, ask it: "watch my
machine". It installs a minutely `machine-watch` routine (`ghost help machine`),
visible and pausable under Routines like any other. The routine stays quiet
under ordinary load and wakes the ghost only near harm: a temperature close to
its critical limit or fans at full speed, memory nearly exhausted, or a disk
nearly full. Each becomes an event conversation naming the busiest programs;
the ghost fixes what is its own or plainly broken, least drastic first, and
asks you before touching anything else.

## Crashes

To have a ghost look into crashes before you ask, tell it: "look into crashes
for me". It installs a minutely `crash-watch` routine (`ghost help crashes`).
Each program that dumps core, at most once an hour, becomes an event
conversation; the ghost works out why and proposes a fix, changing nothing
until you say yes there. Unread findings fill the bar mark in the theme's
magenta with a count. Tell the ghost to stop looking into a program and it
adds that program to the watch's ignore list.
