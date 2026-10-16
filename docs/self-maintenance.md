# Self-maintenance

A ghost can edit, build, and restart the code it runs on. Ghost adds no
machinery for this. The clone is an ordinary directory, git is the
code history, journald is the lifecycle history, and systemd is the guardian
that survives the daemon it restarts.

Only edit the checkout reported by `ghost status` and authorized by the owner.
It powers every ghost on the machine. A packaged install has no checkout;
never edit its root-owned bundles. Read `ghost help self` for the edit, test,
commit, build, and restart recipe. Preserve peer edits and follow the owner's
branch/push instructions.

## Discover the running install

Before deploying, inspect the actual paths:

```sh
systemctl --user cat ghostd.service
command -v ghostd ghost-desktop
readlink -f ~/.config/omarchy/plugins/ferdousbhai.ghost
ghost status
```

The package installs runtime and HUD from one version. Install both packages
together before restarting the daemon and shell; building another checkout
does not update them. The sections below describe an explicit development
override, not a second package distribution channel.

## Run ghostd from a clone

The package installs `/usr/bin/ghostd`, a shell launcher that execs Bun against
`/usr/lib/ghost/runtime/ghostd.js`. That bundle is read-only and root-owned; a
ghost cannot change it. To run your own build instead, keep the packaged unit
and override its `ExecStart` with a launcher of the same shape.

Write the launcher:

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/ghostd-dev <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/bun \
  /home/<owner>/src/ghost/packages/daemon/dist/main.js "$@"
EOF
chmod 755 ~/.local/bin/ghostd-dev
```

Then override the unit:

```sh
systemctl --user edit ghostd.service
```

```ini
[Service]
ExecStart=
ExecStart=%h/.local/bin/ghostd-dev
```

The empty `ExecStart=` is required: without it systemd appends rather than
replaces. Apply with `systemctl --user daemon-reload && systemctl --user
restart ghostd`.

Computer use is a separate executable each harness pass runs as its `ghost`
MCP server: `$GHOST_DESKTOP` when set, else `ghost-desktop` on PATH. It is its own repository,
[ghost-desktop](https://github.com/ferdousbhai/ghost-desktop); to run a clone of it (Bun runs the source directly,
no build), clone it to `~/src/ghost-desktop` and add a second launcher,

```sh
cat > ~/.local/bin/ghost-desktop-dev <<'EOF'
#!/usr/bin/env bash
exec /usr/bin/bun \
  /home/<owner>/src/ghost-desktop/src/main.ts "$@"
EOF
chmod 755 ~/.local/bin/ghost-desktop-dev
```

and `Environment=GHOST_DESKTOP=%h/.local/bin/ghost-desktop-dev` under the same
`[Service]` override. The next turn picks up a pull of that clone.

`ghostd.service` sets `ProtectSystem=strict` with `ReadWritePaths=%h %t`, so the
clone must live under the owner's home. A checkout in `/opt` or `/srv` is
invisible to the daemon's writes even when the file permissions allow them.

The daemon runs on Bun, not Node, and it runs the *built* bundle. Source edits
reach the running daemon only after `pnpm build` and a restart.

### The shell

This section applies when the optional `ghost` UI package or checkout plugin is installed.
Runtime-only updates restart `ghostd.service` without restarting the shell.

The HUD is an omarchy-shell plugin, not a unit of Ghost's. The package
installs it at `/usr/share/ghost/plugin`, and omarchy-shell loads whatever
`~/.config/omarchy/plugins/ferdousbhai.ghost` points at. Point it at the clone
instead:

```sh
mkdir -p ~/.config/omarchy/plugins
# -T, because plain `ln -sfn` onto an existing directory puts the link INSIDE
# it (…/ferdousbhai.ghost/qml) and says nothing. If the packaged plugin is
# already installed there as a real directory this refuses; move it aside first.
ln -sfnT ~/src/ghost/packages/shell/qml ~/.config/omarchy/plugins/ferdousbhai.ghost
omarchy-shell shell rescanPlugins
```

A rescan only discovers the plugin; it does not replace QML the shell has
already loaded, and neither does saving a file under a symlinked plugin
directory. An edit lands with `omarchy-restart-shell`, and
`omarchy-shell shell debugBarGeometry` reports what the running shell actually
has. A syntax error there lands in the owner's whole desktop shell, which is
why previews go through `dev/preview.sh`.

The ghost's prompt carries only what runs it and which clone is its checkout;
the loop, the restart unit, and the undo list are `ghost help self`, read on
the turn that needs them.

## Restarting yourself

A plain restart kills a ghost's own parent. `ghost help self` schedules the
restart in a transient `systemd-run --user` unit that survives the daemon;
its description carries the reason. Finish the turn and tell the owner first:
a restart aborts every running turn. Restarting never sends a model prompt.

The daemon's `TimeoutStopSec` is the shutdown deadline. Read `git log`, the
journal, and the conversation before retrying a failed change. Use a dedicated
clone for live checkout development; shared-tree edits and builds can ship a
peer's work accidentally.

## Verify

```sh
journalctl --user -t ghostd -n 50
systemctl --user status ghostd
ghost status
```

The daemon logs to stderr with journald priority prefixes, and the unit's
`SyslogIdentifier=ghostd` (or, without it, the `ghostd` executable's name)
makes `-t ghostd` catch it. `ghost status` prints the
daemon's version, its commit, and the root of the checkout it is running from,
or reports a packaged install when there is no checkout behind it.

## Canary before adopting

Never prove a build against the owner's ghost or desktop. For a checkout
canary, use a private root and configuration, a fake desktop, and a free
non-live port (7799 below):

```sh
task_canary_dir=$(mktemp -d /tmp/ghost-canary.XXXXXX)
printf '{}\n' > "$task_canary_dir/hooks.json"
GHOSTS_ROOT="$task_canary_dir/ghosts" \
GHOSTD_CONFIG="$task_canary_dir/config.json" \
GHOSTD_HOOKS="$task_canary_dir/hooks.json" \
XDG_STATE_HOME="$task_canary_dir/state" \
GHOST_DESKTOP=/usr/bin/false \
  bun packages/daemon/dist/main.js --port 7799
```

Run that command from the built checkout. Point the client at the canary
with `GHOSTD_PORT=7799` and
`GHOSTD_API_TOKEN_FILE="$task_canary_dir/state/ghost/api-token"`. Stop its captured process
before deleting the scratch directory. Functional desktop/HUD verification
uses the nested preview, never the owner's session. `ghost smoke --no-turn`
also creates an isolated throwaway daemon and reports each stage.

Never port 7717 or `~/ghosts`; scratch configuration also prevents live
owner hooks from running. Every canary must use its own ghost root.

## Rollback

- **Code.** `git revert <sha>` in the checkout, `pnpm build`, restart. The
  commit that broke it and the revert that fixed it are both in `git log`, and
  the reason for each restart is in `journalctl --user -u 'ghost-restart-*'`.
- **A ghost home.** Deletion moves the whole directory to the freedesktop trash,
  with a `.trash/` sibling as the fallback when the trash is on another
  filesystem. Ghost never recursively removes a home, and neither should you.
- **The system.** Omarchy wraps snapper: `omarchy-snapshot create` before a
  risky change, `omarchy-snapshot restore` to go back. Both need sudo, and
  `create` does nothing useful until snapper has a config.

Never `rm -rf` a checkout. `git` already holds every state worth returning to.

> **A shared tree is not a safe clone to run from.** If other agent sessions
> or you edit the same working tree, the ghost's branch, its `git status`, and
> its build will collide with yours, and a restart will ship whatever happened
> to be built last. Give the ghosts their own clone.

## Updates

Omarchy owns package updates. For checkout updates, pull, build, and restart
only within the owner's instructions. See [getting started](https://github.com/ferdousbhai/ghost/blob/master/docs/getting-started.md#10-if-something-is-wrong)
for the packaged upgrade commands.
