# Getting started

Install Ghost and talk to it from its bar or the terminal.

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
never loaded into the conversation automatically. No daemon restart is needed.

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
launcher summons the bar (`ghost-bar`): a prompt at the bottom of the
screen, with what you ask and what the ghost says above it as captions.
Up and Down go back through the conversation, and Escape puts the bar away.
Bind a key to it in `~/.config/hypr/bindings.lua` so it is always one press
away, for example `o.bind("SUPER + CTRL + G", "Ghost", "ghost-bar --listen")`;
with `--listen` the same key starts Omarchy's dictation, and pressed again
ends it, so what you said is in the prompt.

Confirm the client can reach and authenticate to the daemon:

```sh
ghost status
```

It prints the daemon URL, the token file path, the ghost, and whether it is
served to your tailnet; that it prints at all means the daemon answered and
accepted the token (otherwise it exits 3 or 4). The bearer token is minted on
first run at `~/.local/state/ghost/api-token` (mode 0600); the bar and CLI read
that file themselves, and `ghostd api-token` prints it for curl or debugging.
To replace it, delete the file and `systemctl --user restart ghostd`.

## 4. Your ghost

Each machine has one ghost, at home in `~/.local/share/ghost/`. The first time
ghostd starts it makes that directory with a seeded `character.md`;
`ghost status` prints the ghost's name, which is its persona's title (`ghost`
until the persona is written). To rename it, change the title.

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

Summon Ghost from your app launcher, or with the key you bound. Type in the
prompt at the bottom of the screen, and `Enter` sends. What the ghost says
appears above it as captions, with a line saying which command it is
running; `Esc` ends a running turn, and with none puts the bar away. It is
one conversation: `Up` and `Down` go back and forth through it, and
`ghost show` in a terminal lists all of it, the ghost's reasoning
and commands included.

Your notes, mail, photos and the rest stay in their own apps. The ghost
reaches them through each app's command line, and installs or connects one
when you ask it to (`ghost help products` is its guide).

When the ghost needs a decision it asks instead of guessing, with the ways
forward as answers to pick from, the one it recommends first; your next
message is the answer.

## 7. The same ghost from the terminal

```sh
ghost say "What should I focus on today?"
ghost show
ghost stop
ghost new --yes
```

`ghost say` streams the turn; tool activity goes to stderr so stdout stays the
answer. A ghost has one conversation, and every surface is in it: the bar
shows what was said from the terminal, and the reverse. While a turn is
running, `--follow-up` queues text to run after it; with none running it
becomes the next turn, which is how a ghost's own background command reports
back. `ghost new --yes` starts over: the conversation so far goes to Trash,
whole, and the next message begins a new one.

The CLI talks to this machine's ghost. It never edits a ghost home directly:
every change to a ghost goes through the daemon.

`--json` gives you the raw API shape (one event object per line for streams),
`-q` drops secondary output, and `ghost help exit-codes` lists the stable exit
codes.

## 8. Where everything lives

| Path | What |
|---|---|
| `~/.local/share/ghost/` | the ghost home: `character.md` and `conversation/`, the one conversation (its log, attachments, and the directory the ghost's commands run in) |
| `~/.config/ghost/config.json` | daemon config (port, ghost home, remote owner and apps, and the local model) — optional; a missing file is fine, a malformed one is an error |
| `~/.config/ghost/hooks.json` | hook configuration, also edited with `ghost hooks` |
| `~/.local/state/ghost/api-token` | the daemon bearer token |
| `~/.local/state/ghost/push.json` | the devices that get alerts, with their keys |
| `~/.cache/ghost/slot/` | what the model had read when it last stopped (up to some 5 GB), so the conversation is not read again; safe to delete |
| XDG Pictures | browser screenshots, unless you name another destination |

`GHOST_HOME` moves the ghost home, `GHOSTD_CONFIG` the config file, and
`GHOSTD_API_TOKEN_FILE` the API token file.
`GHOSTD_PORT` moves the port the daemon binds on `127.0.0.1` and the CLI and
bar dial (7717 by default).

Nothing in that list is owned by pacman. Upgrading or removing the package
leaves the ghost home, the conversation, tokens, and your documents untouched.

## 9. Optional, once you are talking

- **Use websites.** Install agent-browser; `ghost help browser` covers signed-in Chromium
  setup, shared-session tab locking, and cleanup.
- **Talk instead of typing.** Omarchy's dictation types into the bar's
  prompt as into any app, and `ghost-bar --listen` starts it as the bar opens. Ghost adds no speech stack of its own.
- **Hooks.** [hooks.md](hooks.md); a ghost can write its own with `ghost hooks`.
- **Remote access.** Tailscale Serve is the opt-in: `tailscale serve --bg --https=443 http://127.0.0.1:7717`
  turns it on and `tailscale serve --https=443 off` turns it off. `ghost
  status` then prints the summonghost.com link that adds this machine to the
  app, the phone client ([mobile](mobile.md)).
  Only your own login gets in. On a
  phone, the camera attaches photos; dictate
  with the keyboard's own mic.

## 10. If something is wrong

| Symptom | Check |
|---|---|
| `cannot reach ghostd` / "ghostd is not answering" | `systemctl --user status ghostd.service`; `journalctl --user -u ghostd -e` |
| `unauthorized` (exit 4) | `ghostd api-token` as the machine owner; the bar and CLI read `~/.local/state/ghost/api-token` |
| A turn fails at once | Is `local.model` set in `~/.config/ghost/config.json`, and does `llama-server` start? `journalctl --user -u ghostd -e` has its error |

After an upgrade, restart the daemon to load the new build:

```sh
systemctl --user restart ghostd.service
```
