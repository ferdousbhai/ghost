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
([#54](https://github.com/ferdousbhai/ghost/issues/54)), one line installs the
`ghost` package from Omarchy's repository and starts it for this login, and
`omarchy update` keeps it current:

```sh
curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash
```

For checkout development, use the
[rolling package recipe](../packaging/arch/README.md). Install matching runtime
and UI packages together; a workspace build alone does not update the app.

The installer configures this login. Installing the package directly only
puts files in place; finish setup in section 3.

### Product skills through Bash

Nothing to install: every conversation already has Ghost's product index,
[`skills/ghost-products`](../skills/ghost-products/SKILL.md). It lists the
recommended products (Cloudmail, Cloud Calendar, Cloud Contacts, Cloud Tasks,
iCloud apps, Omacloud, gws for Drive/Docs/Sheets, wacli, and Omdrop); the ghost
installs a product when needed, and the product installs its own skill
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

The one-line installer already starts the daemon and links/enables the HUD.
If you installed the package directly, run that installer to finish setup;
it waits for plugin discovery before enabling it. Runtime-only installs need
just `systemctl --user enable --now ghostd.service`.

`ghostd.service` is `PartOf=graphical-session.target`: it comes up with your
compositor and dies with it, and binds `127.0.0.1:7717`. The HUD is not a unit
— it is a plugin inside your own `omarchy-shell`, summoned with
`omarchy-shell shell toggle ferdousbhai.ghost`.

Confirm the client can reach and authenticate to the daemon:

```sh
ghost status
```

It prints the daemon URL, `reachable yes`, `authenticated yes`, the token file
path, the ghost count, and remote-access state. The bearer token is minted on
first run at `~/.local/state/ghost/api-token` (mode 0600); the HUD and CLI read
that file themselves, and `ghostd api-token` prints it for curl or debugging.
To replace it, delete the file and `systemctl --user restart ghostd`.

**Summon key.** Packaging deliberately never edits `~/.config/hypr` or
`~/.config/omarchy`. To bind `SUPER+CTRL+G`, copy the snippet you need from
`/usr/share/doc/ghost/shell-contrib/` — `hyprland/ghost.lua` for Omarchy 4's
Lua config, `hyprland/ghost.conf` for plain Hyprland. Until you do, open the
HUD from your app launcher, or with
`omarchy-shell shell toggle ferdousbhai.ghost`.

## 4. Create a ghost

Terminal:

```sh
ghost new sage
ghost use sage        # save it as your default ghost (~/.config/ghost/cli.json)
ghost list
```

HUD: in the left sidebar (`Ctrl+B` toggles it), click the `+` in the **Ghosts**
header, type a name, press Enter.

Either route posts to the same daemon route, which creates `~/ghosts/sage/`
with a seeded `character.md`.
Names are 1–64 characters of letters, digits, `.`, `_`, or `-`, and may not
start with a dot. The directory name *is* the ghost's name.

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

## 6. First conversation in the HUD

Summon the HUD (`SUPER+CTRL+G`, your app launcher, or
`omarchy-shell shell toggle ferdousbhai.ghost`). An
empty conversation shows the ghost's glyph, its name, and the static line
`What's on your mind?`.

Type, and:

| Key | Effect |
|---|---|
| `Enter` | send |
| `Shift+Enter` | newline |
| `Enter` *(mid-turn)* | queue the text; it runs as soon as the current pass ends |
| `Esc` | dismiss a pending confirmation, then stop a running turn, then close the workbench — it never closes the window |
| `Ctrl+B` | show or hide the ghosts/conversations sidebar |
| `Ctrl+N` | start a new conversation (the composer's `+`) |
| `PageUp` / `PageDown` | scroll the transcript a page |
| `Ctrl+Home` / `Ctrl+End` | jump to the transcript's start / back to its end, following new output again |
| `Ctrl+Shift+Up` / `Ctrl+Shift+Down` | jump to your previous / next message |

The transcript follows new output only while you are at its end. Scrolled
up, it stays put and shows **↓ Jump to latest message**; its scrollbar
appears only while it moves or under the pointer.

The rail on the right switches sections: **Chat**, **Board**,
**Character**, **Hooks**, **MCP**, and **Remote access**. Clicking the ghost
mark in the Omarchy bar toggles the HUD.

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
carries both variables. It is an HTTP client and
nothing else — it never edits a ghost home directly, so the HUD sees everything
it does immediately, and the reverse.

`--json` gives you the raw API shape (one event object per line for streams),
`-q` drops secondary output, and `ghost help exit-codes` lists the stable exit
codes.

## 8. Where everything lives

| Path | What |
|---|---|
| `~/ghosts/<name>/` | the ghost home: `character.md`, `settings.yml`, `mcp.json`, and `sessions/<id>/`, one directory per conversation |
| `~/.config/ghost/config.json` | daemon config (port, host, ghosts root, remote) — optional; a missing file is fine, a malformed one is an error |
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
- **Remote access.** `ghostd remote status` (or the HUD's Remote access pane)
  controls the opt-in Tailscale Serve viewer. Guests are read-only. On a
  phone, `+` starts a conversation and the camera attaches photos; dictate
  with the keyboard's own mic.

## 10. If something is wrong

| Symptom | Check |
|---|---|
| `cannot reach ghostd` / "ghostd is not answering" | `systemctl --user status ghostd.service`; `journalctl --user -u ghostd -e` |
| `unauthorized` (exit 4) | `ghostd api-token` as the machine owner; the HUD and CLI read `~/.local/state/ghost/api-token` |
| The HUD never appears | `omarchy plugin list` should show `ferdousbhai.ghost` enabled; if not, rerun the installer to link it, wait for discovery, and enable it. |
| A turn fails at once | `ghost harnesses` — is any supported agent installed? Run that agent by hand once to confirm it is signed in |
| You want a check that touches nothing | `ghost smoke --no-turn` runs a throwaway daemon on a free port against a temporary ghost home and reports each stage; drop `--no-turn` (and add `--harness <id>`) for a real two-turn check |

After an upgrade, re-enable to migrate older unit enablement, then restart
the active daemon to load the new bundle:

```sh
systemctl --user reenable --now ghostd.service
systemctl --user restart ghostd.service
omarchy-restart-shell
```

A rescan discovers a plugin; it does not replace QML the running shell has
already loaded, so an upgraded HUD needs the shell restart.
