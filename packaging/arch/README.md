# Omarchy package and checkout recipe

> **RELEASE HOLD:** this checkout recipe is for development and isolated
> acceptance only. Do not create a release repository or tag, dispatch the
> release workflow, publish a package, submit an Omarchy contribution, or install
> it on the owner's live machine until the owner lifts the hold and #17 is
> complete for the exact candidate.

`PKGBUILD` builds `ghost-dev`, the rolling checkout package. It provides and
conflicts with stable `ghost`, so the variants cannot be installed together.
`/usr/bin/ghostd` and `/usr/bin/ghost` are fixed launchers for ordinary
Bun-target bundles under `/usr/lib/ghost/runtime`. The package depends on
system Bun 1.3.14 or newer at runtime; building and checking the current
toolchain requires Bun 1.4.0 or newer. Native delegated-task ownership also
requires `systemd>=254`. It installs no source or `node_modules` tree. Ghost,
pi, provider, and MCP application code plus required static assets remain
packaged for offline use.

`fd` and `ripgrep` are explicit runtime dependencies because pi's native
`find` and `grep` tools invoke them. Providing the system binaries prevents a
read-only planning turn from downloading either tool into pi's cache. The
stable `ghost` release-source machinery lives under `packaging/release/`; its
v3 runtime source carries the same bundles, launchers, and exact bundled-license
closure.

Build the checkout package without installing it:

```sh
makepkg --cleanbuild
```

## Optional CLI integrations

The package does not install the native Pi, Codex, or Claude Code worker
executables. Install and authenticate the ones you want through their upstream
or Omarchy/mise mechanism, then run `ghost delegation` to inspect the bounded
public status without opening ghost data. Default discovery uses `pi`, `codex`,
and `claude` from ghostd's captured startup `PATH` and resolves recognized mise
launchers to their installed targets. A service-level `GHOST_PI_BINARY`,
`GHOST_CODEX_BINARY`, or `GHOST_CLAUDE_BINARY` selects a literal owner
executable/wrapper instead and is never mise-unwrapped; prefer an absolute
path. Restart ghostd after changing that service environment; a fresh probe
detects an installed or mise target rotation. Missing, malformed, or
unauthenticated boundaries remain visibly
`unavailable` or `logged_out` rather than silently falling back to another
harness. See the daemon's
[native coding-worker guidance](../../packages/daemon/README.md#native-coding-worker-harnesses)
for the exact discovery semantics.

Ghost packages none of these CLIs or skills. Install only the integrations you
want as the desktop user; the upstream installer then owns its files and
updates. The package's optional dependencies expose the system prerequisites.
Install the shared npm prerequisite once if you did not select it with Ghost:

```sh
omarchy pkg add npm
```

[Firecrawl](https://github.com/firecrawl/cli) provides keyless web search and
scraping plus its official skills:

```sh
npx -y firecrawl-cli@latest init --all --skip-auth
```

Replace `--skip-auth` with `--browser` to sign in during setup.

[HEY](https://github.com/basecamp/hey-cli) is installed by current Omarchy
through its mise wrapper. If `hey` is missing, run `omarchy update` to receive
that migration. [Basecamp](https://github.com/basecamp/basecamp-cli) is in
Omarchy's package repository. Both CLIs embed their own skills:

```sh
hey skill install
hey auth login

omarchy pkg add basecamp-cli
basecamp skill install
basecamp auth login
```

Obsidian 1.12.7 or newer includes its CLI. Enable **Settings → General →
Command line interface** in Obsidian, then install the Obsidian CEO's
[skill pack](https://github.com/kepano/obsidian-skills):

```sh
omarchy pkg add obsidian
npx -y skills@latest add https://github.com/kepano/obsidian-skills \
  --global --yes \
  --skill json-canvas obsidian-bases obsidian-cli obsidian-markdown
```

Google publishes both the
[Google Workspace CLI](https://github.com/googleworkspace/cli) and its skills:

```sh
npm install -g @googleworkspace/cli
npx -y skills@latest add https://github.com/googleworkspace/cli \
  --global --yes \
  --skill gws-calendar gws-chat gws-docs gws-drive gws-forms gws-gmail \
    gws-keep gws-meet gws-people gws-shared gws-sheets gws-slides gws-tasks \
    gws-workflow
gws auth setup
```

Open a new pi session after installing skills. Ghost uses pi's native parser to
snapshot every valid skill visible under `~/.agents/skills/` and
`~/.pi/agent/skills/`, following symlinks in those standard machine roots.
There is no hardcoded skill-name allowlist or integration-specific package path.

The Claude Code path uses the owner's complete, unmodified Claude Code harness
(CLI 2.1.251 or newer) and any native authentication/provider path that its CLI
reports logged in. The package does not ship the Claude Agent SDK. To use that
path, follow the exact versioned installation and Option C environment boundary
in
[`docs/claude-code-runtime.md`](../../docs/claude-code-runtime.md#runtime-and-security-boundary).
Its exact Agent SDK and peer packages live only in Ghost's versioned
mode-`0700` owner-data boundary described there; neither the checkout nor the
stable runtime archive redistributes them.

Before opening a session, install `libsecret` (for `secret-tool`) and run a
user-session Secret Service provider such as `gnome-keyring`; its default
collection must be available to `ghostd`. See
[keyring credentials](../../docs/keyring.md) for failure behavior and the
blank-password/autologin caveat.

This remains the rolling, checkout-only development package: `pnpm install`
may populate its store during `build()`. The stable `ghost` package uses the
[v3 runtime-source mechanism](../release/README.md#reproducibility-boundary)
and also installs `/usr/bin/ghostd` and `/usr/bin/ghost`. Ghost creates only
the source/runtime candidate and an Omarchy contribution template; Omarchy
owns the stable package build, signing, repository, and promotion. Ghost has no
generic Arch publication channel, pacman repository, or package-signing key.

The shell is installed at `/usr/share/ghost/quickshell` and exposed as the
system Quickshell config `ghost`, so the existing `qs -c ghost` integration and
`ghost-launch` command work without writing into a user's config directory.
The browser relay is installed at `/usr/share/ghost/chromium-extension`; load
that directory with Chromium's **Load unpacked** flow. The computer-use helper
is installed in a private Python import directory and exposed through
`ghost-desktop-helper`, preventing its vendored `omaharness` modules from
colliding with a system Python package.

## Desktop boundary

The supported release target is Omarchy. Ghost depends on Omarchy's Hyprland
and Quickshell desktop shape, and carries its Lua keybinding and optional native
bar integration under `/usr/share/doc/ghost/shell-contrib/` for the owner to
enable. There is no generic Arch/Hyprland support promise. Packaging never
edits `~/.config/hypr` or `~/.config/omarchy`.

## Upgrades, rollback, and uninstall

The package owns only files under `/usr`, plus the system Quickshell symlink at
`/etc/xdg/quickshell/ghost`. It does not create or own `~/ghosts`,
`~/.config/ghost`, or `~/.local/state/ghost`. Upgrading or removing it therefore
leaves personas, docs, memory, sessions, provider credentials, and API tokens
untouched.

An upgrade requires `systemctl --user reenable --now ghostd.service
ghost-shell.service`; re-enabling also moves an installation made with the old
daemon unit away from `default.target` and into the graphical-session lifecycle.
A package rollback uses the normal pacman cache
(`pacman -U /var/cache/pacman/pkg/<package>.pkg.tar.zst`) and likewise does not
roll back or delete user data. Ghost-home format changes must remain
forward/restart-safe under `CONTRACTS.md`; packaging does not invent a second
migration path.

Before uninstalling `ghost-dev`, stop and disable both user units:

```sh
systemctl --user disable --now ghost-shell.service ghostd.service
sudo pacman -Rns ghost-dev
```

For stable `ghost`, the final command is `sudo pacman -Rns ghost`.

That removes package-owned files only. It deliberately leaves `~/ghosts`,
provider credentials, and API/relay tokens untouched.

`smoke.sh` validates a staged package tree, including daemon startup metadata,
the private helper imports, desktop entry, Chromium manifest, Quickshell assets,
and graphical-session service binding. `package()` runs it before producing the
archive, and the Arch workflow builds the package in a clean container.

For a real service-context check on a graphical Arch login, run:

```sh
/usr/lib/ghost/package-smoke/service-browser-smoke.sh
```

It uses `/usr/bin/ghost status --json` to verify that the terminal client can
authenticate to the active packaged daemon, then reads `/api/relay/status` to
verify the browser relay endpoint is serving from it. Ghost launches no browser
of its own — the relay dials out of a Chromium the owner started — so there is
no launch policy to probe. CI containers do not run a graphical user manager, so
this stays a release-machine check.
