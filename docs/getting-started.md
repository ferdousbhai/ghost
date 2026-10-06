# Getting started

Ten minutes from a bare Omarchy machine to a named ghost answering you in the
HUD and in the terminal. Every command below is the real one; nothing here is
a placeholder.

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

Open the Omarchy menu, then **Install → AI → Ghost**. Until the package is in
Omarchy's repository ([#54](https://github.com/ferdousbhai/ghost/issues/54)),
one line adds Ghost's own signed package repository (each release doubles as
one) and installs the same package from it, so `omarchy update` keeps it
current:

```sh
curl -fsSL https://ferdousbhai.com/ghost/install.sh | bash
```

To work on Ghost itself, build the rolling checkout package instead — see
[`packaging/arch/README.md`](../packaging/arch/README.md) for what it installs,
why each dependency is there, and the upgrade and uninstall paths:

```sh
git clone https://github.com/ferdousbhai/ghost.git
cd ghost/packaging/arch && makepkg --cleanbuild
sudo pacman -U ghost-dev-*.pkg.tar.zst
```

Either way the package only puts files in place; it creates nothing in your
home and edits no configuration of yours. The post-install hook prints the
commands that finish the job, which are section 3 — do not skip it.

## 2. Where shared notes go

Nothing to install. Your XDG Documents directory (`xdg-user-dir DOCUMENTS`,
usually `~/Documents`) is the owner-shared scope: every ghost reads and writes
it with its harness's native file tools, its own notes included. Ghost does
not index the directory or read any of it until a request
calls for it.

### Bring your own UI

For a remote desktop with an app-provided UI, install `ghost-runtime` instead of
`ghost`. It includes the daemon/API, CLI, `ghost-desktop`, and browser relay,
without Ghost's HUD, launcher, icons, or Quickshell dependency. Start only
`ghostd.service`; the graphical-session and authentication requirements below
still apply. See [runtime install and UI removal](../packaging/arch/README.md#runtime-with-your-own-ui).

## 3. Start the services

```sh
systemctl --user enable --now ghostd.service
ln -sfn /usr/share/ghost/plugin ~/.config/omarchy/plugins/ferdousbhai.ghost
omarchy-shell shell rescanPlugins && omarchy plugin enable ferdousbhai.ghost
systemctl --user status ghostd.service --no-pager
```

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
<name>`), then any other installed agent whose usage windows have room:

```sh
ghost harnesses          # which agents are installed and which have room
```

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

An agent that cannot take a turn — not signed in, out of quota — hands it to
the next, which is given the conversation so far. The model, sign-in, tools,
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
| `~/.local/state/ghost/relay-token` | the browser-relay pairing token |
| XDG Pictures | `ghost-<ghost>-{screen,browser}-<timestamp>.png` screenshots |

`GHOSTS_ROOT` moves the ghosts root, `GHOSTD_CONFIG` the config file, and
`GHOSTD_API_TOKEN_FILE` / `GHOSTD_RELAY_TOKEN_FILE` the token files.
`GHOSTD_HOST` and `GHOSTD_PORT` move the endpoint the daemon binds and the CLI
and HUD dial (`127.0.0.1:7717` by default; the daemon refuses a non-loopback
host).

Nothing in that list is owned by pacman. Upgrading or removing the package
leaves personas, conversations, tokens, your documents,
and any skill you installed untouched.

## 9. Optional, once you are talking

- **Lend the ghost your browser.** It has none until you pair the
  [Ghost extension](https://github.com/ferdousbhai/ghost-chromium-extension)
  (submitted to the Chrome Web Store 2026-09-21, not yet listed; until then,
  the release zip loaded unpacked). In its side panel's
  menu choose **Ghost on this machine…**, then open the HUD and press Allow
  when it shows the same code. Read the extension's README first — the ghost
  acts in the session you are signed into.
- **Talk instead of typing.** Install Omarchy's dictation (the Omarchy menu,
  Install → AI → Dictation, which sets up Voxtype). With the composer focused,
  hold `F9` and speak, or click the mic at the right of the composer; the
  composer says when it is listening. Ghost adds nothing else: no speech
  stack, no voice of its own.
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
| The HUD never appears | `omarchy plugin list` should show `ferdousbhai.ghost` enabled; if not, link it into `~/.config/omarchy/plugins/` and `omarchy-shell shell rescanPlugins`. |
| A turn fails at once | `ghost harnesses` — is any agent installed with room? Run that agent by hand once to confirm it is signed in |
| You want a check that touches nothing | `ghost smoke --no-turn` runs a throwaway daemon on a free port against a temporary ghost home and reports each stage; drop `--no-turn` (and add `--harness <id>`) for a real two-turn check |

After an upgrade, re-enable rather than restart, so an installation made with
an older unit moves onto the graphical-session lifecycle:

```sh
systemctl --user reenable --now ghostd.service
omarchy-restart-shell
```

A rescan discovers a plugin; it does not replace QML the running shell has
already loaded, so an upgraded HUD needs the shell restart.
