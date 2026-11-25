# Self-maintenance

A ghost can edit, build, and restart the code it runs on. Ghost adds no
machinery for this. The clone is an ordinary directory, git is the
code history, journald is the lifecycle history, and systemd is the guardian
that survives the daemon it restarts.

Any part of Ghost's code is a ghost's to change, to fit its owner: its
persona, its window, its daemon, its recipes. On Omarchy, Ghost is a packaged
install whose files pacman owns and a ghost cannot write; a ghost changes
itself by running from its own clone instead, as below, which needs no sudo beyond
installing `cargo` and is undone in a few commands. That clone runs the
machine's ghost, so the ghost tells the owner before it switches over
and before it restarts. Read `ghost help self` for the edit, test, commit,
build, and restart recipe. Preserve peer edits and follow the owner's
branch/push instructions.

## Discover the running install

Before deploying, inspect the actual paths:

```sh
systemctl --user cat ghostd.service
command -v ghostd ghost-window
ghost status
```

The package installs the daemon and the window from one version; building
another checkout does not update them. The sections below describe an explicit development
override, not a second package distribution channel.

## Run ghostd from a clone

The package installs `/usr/bin/ghostd`, a native binary. It is read-only and
root-owned; a ghost cannot change it. To run your own build instead, keep the
packaged unit and override its `ExecStart` with the clone's binary.

Clone and build first. The build needs `git`, GTK 4 (installed with Ghost) and
`cargo` (`omarchy-pkg-add rust`, which asks for the owner's password):

```sh
git clone https://github.com/ferdousbhai/ghost ~/src/ghost
cd ~/src/ghost && cargo build --release --locked
```

Link the `ghost` command to the clone's build, so `ghost help` and the CLI
match the code that runs (`~/.local/bin` comes first on the unit's `PATH`):

```sh
mkdir -p ~/.local/bin
ln -sf ~/src/ghost/target/release/ghost ~/.local/bin/ghost
```

Then override the unit with a drop-in, the file `systemctl --user edit`
writes, without its editor:

```sh
mkdir -p ~/.config/systemd/user/ghostd.service.d
cat > ~/.config/systemd/user/ghostd.service.d/clone.conf <<'EOF'
[Service]
ExecStart=
ExecStart=%h/src/ghost/target/release/ghostd
EOF
systemctl --user daemon-reload
```

The empty `ExecStart=` is required: without it systemd appends rather than
replaces. Restart into it the way `ghost help self` does, from a transient
unit, so the restart survives the daemon it stops.

`ghostd.service` sets `ProtectSystem=strict` with `ReadWritePaths=%h %t`, so the
clone must live under the owner's home. A checkout in `/opt` or `/srv` is
invisible to the daemon's writes even when the file permissions allow them.

The daemon runs the *built* binary. Source edits reach the running daemon
only after `cargo build --release --locked` and a restart.

### The window

The window is one binary, `ghost-window`, and a client of the daemon's API.
The same build compiles a clone's to `target/release/ghost-window`;
run that file to use it, and close the window to go back
to the packaged one. `packages/window/dev/qa.sh` walks a change's flows, with
screenshots, against a scratch ghostd and a stand-in model.

The ghost's prompt carries none of this: the loop, the restart unit, and the
undo list are `ghost help self`, read on the turn that needs them.

## Restarting yourself

A plain restart kills a ghost's own parent. `ghost help self` schedules the
restart in a transient `systemd-run --user` unit that survives the daemon;
its description carries the reason. Finish the turn and tell the owner first:
a restart aborts every running turn and sends no model prompt.

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
or reports a packaged install when there is no checkout behind it, then when
the daemon started. It adds a `restart needed` line when the code on disk is
newer than the running daemon: an install or a build that has not been
restarted into yet. Dev builds all report the same version, so this line,
not the version, is what says an update is live.

## Canary before adopting

Never prove a build against the owner's ghost or desktop. For a checkout
canary, use a private root and configuration and a free
non-live port (7799 below):

```sh
task_canary_dir=$(mktemp -d /tmp/ghost-canary.XXXXXX)
printf '{}\n' > "$task_canary_dir/hooks.json"
GHOSTS_ROOT="$task_canary_dir/ghosts" \
GHOSTD_CONFIG="$task_canary_dir/config.json" \
GHOSTD_HOOKS="$task_canary_dir/hooks.json" \
XDG_STATE_HOME="$task_canary_dir/state" \
  target/release/ghostd --port 7799
```

Run that command from the built checkout. Point the client at the canary
with `GHOSTD_PORT=7799` and
`GHOSTD_API_TOKEN_FILE="$task_canary_dir/state/ghost/api-token"`. Stop its captured process
before deleting the scratch directory. Functional window verification
uses `packages/window/dev/qa.sh`, never the owner's session.

Never port 7717 or `~/ghosts`; scratch configuration also prevents live
owner hooks from running. Every canary must use its own ghost root.

## Rollback

- **Code.** `git revert <sha>` in the checkout, `cargo build --release --locked`, restart. The
  commit that broke it and the revert that fixed it are both in `git log`, and
  the reason for each restart is in `journalctl --user -u 'ghost-restart-*'`.
- **A ghost home.** Deletion moves the whole directory to the freedesktop trash
  with `gio trash`, which refuses rather than copies across filesystems;
  `gio trash --restore` puts it back. Ghost never recursively removes a home,
  and neither should you.
- **The system.** Omarchy wraps snapper: `omarchy-snapshot create` before a
  risky change, `omarchy-snapshot restore` to go back. Both need sudo, and
  `create` does nothing useful until snapper has a config.

Never `rm -rf` a checkout. `git` already holds every state worth returning to.

> **A shared tree is not a safe clone to run from.** If other agent sessions
> or you edit the same working tree, the ghost's branch, its `git status`, and
> its build will collide with yours, and a restart will ship whatever happened
> to be built last. Give the ghost its own clone.

## Back to the package

```sh
rm -f ~/.config/systemd/user/ghostd.service.d/clone.conf ~/.local/bin/ghost
systemctl --user daemon-reload
```

Then restart ghostd (as above). The
clone stays where it is, and `git` in it still holds every change.

## Updates

Omarchy owns package updates. While a ghost runs from its clone, a package
update changes nothing that runs; the clone takes upstream changes with
`git pull`, a build, and a restart, within the owner's instructions. See [getting started](https://github.com/ferdousbhai/ghost/blob/master/docs/getting-started.md#10-if-something-is-wrong)
for the packaged upgrade commands.
