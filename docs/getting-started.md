# Getting started

Install Ghost and talk to it in its window or the terminal.

For what the pieces *are*, read [concepts.md](concepts.md) after — or instead
of — this page.

## 0. What you need

- **Omarchy**. Ghost depends on that desktop; there is no generic
  Arch/Hyprland support promise.
- **The package's dependencies** —
  pacman installs them with the package.
- **A model on this machine.** Every turn runs on a local model, so your
  notes, chats, mail and files stay on the computer: a GGUF file and
  `llama-server` ([section 5](#5-the-local-model)). Without one Ghost answers nothing.

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
package is the same, and `omarchy update` keeps it current afterwards.
It also starts Ghost for your login (section 3).

To run from a checkout instead, follow
[the maintenance runbook](self-maintenance.md).

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

Nothing to install: a ghost reads the product index with `ghost help
products`. It lists the recommended products; the ghost installs a product
when needed, and the product installs its own skill
(`<cli> skill install`). Ghost uses
these product CLIs from the model's shell, reading each one's skill; no
additional daemon integration or MCP server is needed.

Each skill explains how to detect and install its missing CLI and use existing
accounts. The owner completes sign-in windows and keeps passwords/recovery keys
out of chat. Installing a package does not authorize sending messages, changing
mail routing, or restoring/syncing files.

A ghost sees the
same skills your agents do (`~/.agents/skills`); Ghost adds none of its own. Source checkouts are
never loaded into a conversation automatically. No daemon restart is needed.

## 2. Where shared notes go

Nothing to install. Your XDG Documents directory (`xdg-user-dir DOCUMENTS`,
usually `~/Documents`) is the owner-shared scope: the ghost reads and writes
it from its shell. Two folders there matter to a ghost, with or without
iCloud: `Notes` (Markdown notes, yours and its own: its memory, which it
keeps current) and `Reminders` (your to-do list, one checklist per list, to
which it adds what it needs you to do). Ghost does not index the directory
or read any of it until a request calls for it. For search by meaning, a
ghost can offer to install Recall, which indexes only the folders you choose.

## 3. Confirm setup

The Install → AI → Ghost entry starts the daemon. After `omarchy pkg add
ghost`, do the same for this login:

```sh
systemctl --user enable --now ghostd.service
```

`ghostd.service` is `PartOf=graphical-session.target`: it comes up with your
compositor and dies with it, and binds `127.0.0.1:7717`. Ghost in your app
launcher opens the window (`ghost-window`): your conversations with the
ghost.

Confirm the client can reach and authenticate to the daemon:

```sh
ghost status
```

It prints the daemon URL, the token file path, the ghost, and whether it is
served to your tailnet; that it prints at all means the daemon answered and
accepted the token (otherwise it exits 3 or 4). The bearer token is minted on
first run at `~/.local/state/ghost/api-token` (mode 0600); the window and CLI read
that file themselves, and `ghostd api-token` prints it for curl or debugging.
To replace it, delete the file and `systemctl --user restart ghostd`.

## 4. Your ghost

Each machine has one ghost. The first time ghostd starts and finds no ghost home, it
makes `~/ghosts/ghost/` with a seeded `character.md`; `ghost status` prints the
name. The directory name *is* the ghost's name. To use another (1–64
characters of letters, digits, `.`, `_`, or `-`, starting with a letter or
digit), rename the directory while ghostd is stopped:

```sh
systemctl --user stop ghostd.service
mv ~/ghosts/ghost ~/ghosts/sage
systemctl --user start ghostd.service
```

While `character.md` is still the seed, the ghost knows it has not met you: it
helps with what you asked first, learns about you in the gaps, and offers a
character draft for your approval before writing itself. Nothing is blocked
waiting for that.

## 5. The local model

Set `local` in `~/.config/ghost/config.json` and restart ghostd:

```json
{ "local": { "model": "/path/to/model.gguf", "server": "/path/to/llama-server" } }
```

`server` may be left out when `llama-server` is on your `PATH`. What to
install is in `ghost help products`, under "Running locally". No guide names
a model, since the best one changes too often; what was measured, on which
machine and when, is in [local-models.md](local-models.md). Ghost starts the server on
the first turn and stops it after five idle minutes.

The model has two tools, a shell that runs as you and a question to you
with answers to pick from, and Ghost has no other
model, model picker, or provider login. For work on code it runs your coding
agent (Claude Code, Codex, or Antigravity, when it is your Omarchy default
agent) by that agent's own command, in the
project's directory, with that agent's own sign-in. What it hands that agent
leaves the machine; nothing else does.

## 6. First conversation

Open Ghost from your app launcher. **Ask** is a conversation with the ghost:
type, and `Enter` sends (`Shift+Enter` is a newline). The answer streams in
with a line saying what the ghost is doing; `Esc` or **Stop** ends a running
turn. Your conversations are listed beside it, and **New chat** starts one.

Your notes, mail, photos and the rest stay in their own apps. The ghost
reaches them through each app's command line, and installs or connects one
when you ask it to (`ghost help products` is its guide).

When the ghost needs a decision it asks instead of guessing, with the ways
forward as answers to pick from, the one it recommends first; your next
message in that conversation is the answer.

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

The CLI talks to this machine's ghost; the session is `-s`,
then `$GHOST_SESSION`, then the most recently updated one. A ghost's own shell
carries that variable. It never edits a ghost home directly: every change to
a ghost goes through the daemon, so the window shows the same conversations,
and the reverse.

`--json` gives you the raw API shape (one event object per line for streams),
`-q` drops secondary output, and `ghost help exit-codes` lists the stable exit
codes.

## 8. Where everything lives

| Path | What |
|---|---|
| `~/ghosts/<name>/` | the ghost home: `character.md` and `sessions/<id>/`, one directory per conversation |
| `~/.config/ghost/config.json` | daemon config (port, ghosts root, remote owner, guests, and apps, and the local model) — optional; a missing file is fine, a malformed one is an error |
| `~/.config/ghost/hooks.json` | hook configuration, also edited with `ghost hooks` |
| `~/.local/state/ghost/api-token` | the daemon bearer token |
| XDG Pictures | browser screenshots, unless you name another destination |

`GHOSTS_ROOT` moves the ghosts root, `GHOSTD_CONFIG` the config file, and
`GHOSTD_API_TOKEN_FILE` the API token file.
`GHOSTD_PORT` moves the port the daemon binds on `127.0.0.1` and the CLI and
window dial (7717 by default).

Nothing in that list is owned by pacman. Upgrading or removing the package
leaves the ghost home, conversations, tokens, and your documents untouched.

## 9. Optional, once you are talking

- **Use websites.** Install agent-browser; `ghost help browser` covers signed-in Chromium
  setup, shared-session tab locking, and cleanup.
- **Talk instead of typing.** Omarchy's dictation types into the window's
  composer as into any app. Ghost adds no speech stack of its own.
- **Hooks.** [hooks.md](hooks.md); a ghost can write its own with `ghost hooks`.
- **Remote access.** Tailscale Serve is the opt-in: `tailscale serve --bg --https=443 http://127.0.0.1:7717`
  turns it on and `tailscale serve --https=443 off` turns it off. `ghost
  status` then prints the summonghost.com link that adds this machine to the
  app, the phone client ([mobile](mobile.md)).
  Only your own login gets in;
  to let other tailnet members read along, set `remote.guests` to
  `"read-only"` in the config. On a
  phone, `+` starts a conversation and the camera attaches photos; dictate
  with the keyboard's own mic.

## 10. If something is wrong

| Symptom | Check |
|---|---|
| `cannot reach ghostd` / "ghostd is not answering" | `systemctl --user status ghostd.service`; `journalctl --user -u ghostd -e` |
| `unauthorized` (exit 4) | `ghostd api-token` as the machine owner; the window and CLI read `~/.local/state/ghost/api-token` |
| A turn fails at once | Is `local.model` set in `~/.config/ghost/config.json`, and does `llama-server` start? `journalctl --user -u ghostd -e` has its error |

After an upgrade, restart the daemon to load the new build:

```sh
systemctl --user restart ghostd.service
```
