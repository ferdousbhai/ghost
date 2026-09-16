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
- **A model provider you can sign into** — an OpenRouter account is enough, and
  its free models cost nothing.

## 1. Install the package

Open the Omarchy menu, then **Install → AI → Ghost**. That installs the `ghost`
package from Omarchy's repository, enables the `ghostd` user service, links the
HUD plugin into your shell, and tells you the summon key. Skip to [section 4](#4-create-a-ghost)
afterwards; sections 2 and 3 describe what it did. Until the package is in
Omarchy's repository ([#54](https://github.com/ferdousbhai/ghost/issues/54)),
the same package is built from the latest release, which carries its
`PKGBUILD`; one line does the whole thing on Omarchy:

```sh
curl -fsSL https://summonghost.com/install | bash
```

To work on Ghost itself, build the rolling checkout package instead:

```sh
git clone https://github.com/ferdousbhai/ghost.git
cd ghost/packaging/arch
makepkg --cleanbuild
sudo pacman -U ghost-dev-*.pkg.tar.zst
```

`makepkg` builds from a fresh clone of the branch, runs the full test suite in
`check()`, and stages the payload. Installing it puts `/usr/bin/ghostd` and
`/usr/bin/ghost` on your PATH, the Quickshell config at
`/usr/share/ghost/quickshell` (exposed as the system config `ghost`), the
browser relay at `/usr/share/ghost/chromium-extension`, and the two user units
under `/usr/lib/systemd/user/`. It creates nothing in your home directory.

The post-install hook prints the relay path and the enable command. Details, dependency reasoning, and the uninstall path are in
[`packaging/arch/README.md`](../packaging/arch/README.md).

## 2. Where shared notes go

Nothing to install. Your XDG Documents directory (`xdg-user-dir DOCUMENTS`,
usually `~/Documents`) is the owner-shared scope: every ghost reads and writes
it with its runtime's native file tools, its own notes included. Ghost does
not index the directory or read any of it until a request
calls for it.

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

Either route posts to the same daemon route and writes exactly two things:
`~/ghosts/sage/character.md` (a seed).
Names are 1–64 characters of letters, digits, `.`, `_`, or `-`, and may not
start with a dot. The directory name *is* the ghost's name.

While `character.md` is still the seed, the ghost knows it has not met you: it
helps with what you asked first, learns about you in the gaps, and offers a
character draft for your approval before writing itself. Nothing is blocked
waiting for that.

## 5. Connect a provider and pick a model

Terminal:

```sh
ghost login --list                 # who you can sign in to
ghost login openrouter -g sage
printf %s "$KEY" | ghost login openrouter --key-stdin -g sage
```

`ghost login` goes through the running daemon, which owns the whole flow.
`--oauth` chooses the browser flow where the provider offers both; the default
is the paste-a-key flow. `--key-stdin` reads one key from stdin so a script
never puts it in argv, and `ghost logout <provider>` signs out again. The
credential goes into pi's own store, `~/ghosts/<name>/.pi/auth.json`.

With the daemon stopped, `ghostd login` does the same thing offline:

```sh
ghostd login                    # prompts for ghost and provider
ghostd login sage --provider openrouter
```

In the HUD, the same flow, and on a fresh install it is the first thing you
see: an empty conversation says *Click here to connect a model — free options
exist*, and the card itself opens the pane. The button in the chat header reads
**Connect a model** until one is bound, then shows what is bound. Either opens
the **Connect a model** pane. Each provider
row's primary button is **Sign in**, or the provider's own label — Anthropic's
reads *Sign in (extra usage)*, because third-party calls draw
per-token usage rather than an included Claude plan. Where a provider offers
only an API key the button says **Paste API key**; where it offers both, a
separate **API key** button sits beside the OAuth one.

A successful login binds a usable chat model if the role is still unset, so you
may already be done.

**Which model that is, and why you will not be billed by surprise.** The
binding is chosen from the models pi reports as *available to your credential
at that moment*, not from a list recorded in Ghost — so it reflects the
provider's current roster rather than whatever was current when this was
written. Among those, a zero-cost model wins: signing into OpenRouter for the
free tier binds a free model, and a provider whose models all cost something
(every subscription provider) is unaffected and keeps the ordinary ranking.
Aggregator routers that charge per request are skipped even when the catalogue
lists them at zero (`auth.ts`).

If you have a subscription pi supports — Anthropic, GitHub Copilot, OpenAI
Codex, xAI, Kimi and others in `ghost login --list` — sign into that instead
and the ghost runs on it. `ghost login --list` marks which ones are
subscriptions.

To look and choose explicitly:

```sh
ghost model                        # what is bound now
ghost model openrouter/<model-id>  # bind the chat model
```

A model is always written as `provider/id`, split at the *first* slash — an id
that itself contains slashes is fine. Ghost keeps no catalog: pi validates the
model when the next turn runs. The HUD pill shows the binding and opens the
provider login.

To drive the ghost with a local model, install Ollama or LM Studio from the
Omarchy menu (Install → AI). A local runner is an ordinary provider entry in
`~/ghosts/<name>/models.json`, an OpenAI-compatible endpoint with the models it
serves (the shape is `GhostProviderConfig` in
[`models.ts`](../packages/daemon/src/models.ts)); the easiest way to add one is
to ask the ghost, which has the file and the schema. Then `ghost model
<provider>/<model>` makes it the chat model. Keep a frontier model on
`advisor_model` for the hard questions and for reading images when the local
model cannot.

## 6. First conversation in the HUD

Summon the HUD (`SUPER+CTRL+G`, your app launcher, or
`omarchy-shell shell toggle ferdousbhai.ghost`). An
empty conversation shows the ghost's glyph, its name, and the static line
`What's on your mind?`. A greeting in that ghost's own voice — written by its
`smol_model` — crossfades over the static line a moment later if it arrives; a
failed greeting is silently no greeting, never an error.

Type, and:

| Key | Effect |
|---|---|
| `Enter` | send |
| `Shift+Enter` | newline |
| `Enter` *(mid-turn)* | steer the turn that is already running |
| `Ctrl+Enter` *(mid-turn)* | queue the text as a follow-up instead of steering |
| `Esc` | dismiss a pending confirmation, then stop a running turn, then close the workbench — it never closes the window |
| `Ctrl+B` | show or hide the ghosts/conversations sidebar |

The 64-pixel rail on the right switches sections: **Chat**, **Board**,
**Character**, **Commands**, **Hooks**, **MCP**, and **Remote access**. (The
admitted skills and MCP servers are not a rail section; they read as one line at
the top of a conversation.) Clicking the ghost mark in the Omarchy bar toggles
the HUD.

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
`--steer` and `--follow-up` queue text into it; a `--follow-up` to an idle
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
codes. `ghost skill` prints this command reference as an installable agent
skill, so another agent on this machine can drive the same client.

## 8. Where everything lives

| Path | What |
|---|---|
| `~/ghosts/<name>/` | the ghost home: `character.md`, `sessions/`, `models.json`, and whatever else that ghost uses |
| `~/.config/ghost/config.json` | daemon config (port, host, ghosts root, ask timeout, remote) — optional; a missing file is fine, a malformed one is an error |
| `~/.config/ghost/hooks.json` | hook configuration, also editable from the HUD's Hooks pane |
| `~/.config/ghost/cli.json` | the `ghost use` default, private to your login |
| `~/.local/state/ghost/api-token` | the daemon bearer token |
| `~/.local/state/ghost/relay-token` | the browser-relay pairing token |
| `~/ghosts/<name>/.pi/auth.json` | that ghost's provider logins, written by pi |
| XDG Pictures | `ghost-<ghost>-{screen,browser}-<timestamp>.png` screenshots |

`GHOSTS_ROOT` moves the ghosts root, `GHOSTD_CONFIG` the config file, and
`GHOSTD_API_TOKEN_FILE` / `GHOSTD_RELAY_TOKEN_FILE` the token files.
`GHOSTD_HOST` and `GHOSTD_PORT` move the endpoint the daemon binds and the CLI
and HUD dial (`127.0.0.1:7717` by default; the daemon refuses a non-loopback
host).

Nothing in that list is owned by pacman. Upgrading or removing the package
leaves personas, conversations, credentials, tokens, your documents,
and any skill you installed untouched.

## 9. Optional, once you are talking

- **Lend the ghost your browser.** It has none until you pair the relay: load
  `/usr/share/ghost/chromium-extension` unpacked in your own Chromium, then
  open the HUD and press Allow when it shows the same code as the extension's
  popup. Read
  [`packages/chromium-extension/README.md`](../packages/chromium-extension/README.md)
  first — the ghost acts in the session you are signed into.
- **Talk instead of typing.** Install Omarchy's dictation (the Omarchy menu,
  Install → AI → Dictation, which sets up Voxtype). With the composer focused,
  hold `F9` and speak, or click the dot at the right of the composer; the
  composer says when it is listening. Ghost adds nothing else: no speech
  stack, no voice of its own.
- **Hooks.** [hooks.md](hooks.md); a ghost can write its own with `ghost hooks`.
- **Remote access.** `ghostd remote status` (or the HUD's Remote access pane)
  controls the opt-in Tailscale Serve viewer. Guests are read-only.

## 10. If something is wrong

| Symptom | Check |
|---|---|
| `cannot reach ghostd` / "ghostd is not answering" | `systemctl --user status ghostd.service`; `journalctl --user -u ghostd -e` |
| `unauthorized` (exit 4) | `ghostd api-token` as the machine owner; the HUD and CLI read `~/.local/state/ghost/api-token` |
| The HUD never appears | `omarchy plugin list` should show `ferdousbhai.ghost` enabled; if not, link it into `~/.config/omarchy/plugins/` and `omarchy-shell shell rescanPlugins`. |
| You want a check that touches nothing | `ghost smoke --no-turn` runs a throwaway daemon on a free port against a temporary ghost home and reports each stage |

After an upgrade, re-enable rather than restart, so an installation made with
an older unit moves onto the graphical-session lifecycle:

```sh
systemctl --user reenable --now ghostd.service
omarchy-restart-shell
```

A rescan discovers a plugin; it does not replace QML the running shell has
already loaded, so an upgraded HUD needs the shell restart.
