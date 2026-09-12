# Self-maintenance

A ghost can edit, build, and restart the code it runs on. Ghost adds no
machinery for this. The clone is an ordinary directory, git is the
code history, journald is the lifecycle history, and systemd is the guardian
that survives the daemon it restarts.

Three rules hold the whole thing up:

1. **One clone.** The ghost edits only the clone the daemon runs from, the
   one `ghost status` prints as `daemon source`. Every ghost on the machine is
   powered by that one daemon, so a change there reaches all of them. Not the
   packaged install, not a tree it found, not one you share with other agents.
2. **A restart is a handoff.** The daemon never restarts itself in process. It
   schedules `systemctl --user restart ghostd.service` in a transient
   `systemd-run --user` unit whose `--description` carries the reason.
3. **History is already written.** `git log` in the checkout for what changed,
   `journalctl --user -t ghostd` for what the daemon did, the conversation
   transcript for why. Read them before retrying a change that failed.
   `ghost status` prints the commit the running daemon was built from, so you
   can tell whether a change has actually reached the process.

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
exec /home/<owner>/.bun/bin/bun \
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

The computer-use helper is a separate executable the daemon spawns,
`ghost-desktop-helper` on PATH. To run it from the same clone:

```sh
uv tool install -e ~/src/ghost/packages/desktop-helper
```

An editable install follows the clone's source on every daemon start, so a
pull needs no reinstall unless the helper's dependencies changed; then repeat
the command with `--reinstall`. `uv tool list --show-paths` shows which clone
it points at.

`ghostd.service` sets `ProtectSystem=strict` with `ReadWritePaths=%h %t`, so the
clone must live under the owner's home. A checkout in `/opt` or `/srv` is
invisible to the daemon's writes even when the file permissions allow them.

The daemon runs on Bun, not Node, and it runs the *built* bundle. Source edits
reach the running daemon only after `pnpm build` and a restart.

### The shell

`ghost-shell.service` runs `qs -c ghost --no-duplicate`, and `qs -c ghost`
resolves `$XDG_CONFIG_HOME/quickshell/ghost/shell.qml`. The package installs the
QML at `/usr/share/ghost/quickshell` and exposes it as the system config through
`/etc/xdg/quickshell/ghost`. Point the user config at the clone instead:

```sh
mkdir -p ~/.config/quickshell
ln -sfn ~/src/ghost/packages/shell/qml ~/.config/quickshell/ghost
```

Edited QML is picked up by `systemctl --user restart ghost-shell`, which
re-execs `qs`. `systemctl --user reload ghost-shell` runs the unit's
`ExecReload`, `qs -c ghost ipc call ghost refresh`, which re-polls the daemon for
ghosts, hooks, and sessions. That is a data refresh, not a QML reload. Use
restart for code.

The ghost's prompt carries only what runs it and which clone is its checkout;
the loop, the restart unit, and the undo list are `ghost help self`, read on
the turn that needs them.

## Which checkout

There is nothing to configure. When ghostd runs from a clone, that clone is
the checkout of every ghost on the machine, and the policy says so; when it
runs from the package, no ghost has one. `cwd:` in a ghost's `settings.yml`
can start its conversations inside the clone, or `!cd` into it from a
conversation. Nothing is discovered from the clone; its skills, rules, and MCP
never enter a session.

## The loop

What the ghost does:

1. Read the clone's `CLAUDE.md` and `CONTRACTS.md` first. They are its self map.
2. `git fetch`, branch from `origin/master`, edit, run the touched package
   tests and `typecheck`.
3. Commit with the reason in the message.
4. `pnpm build`.
5. Tell you it is going down, finish the turn, then schedule the restart.

The restart is one `systemd-run --user` command in its own transient unit, so
the daemon stopping cannot take the restarter with it. The exact command,
including the wait for the daemon to listen again and the `ghost say` wake back
into the asking conversation, is the policy text the ghost is given: read
`renderSelfMaintenancePolicy` in
[`self-maintenance.ts`](../packages/daemon/src/self-maintenance.ts). The
shutdown drain is in [`main.ts`](../packages/daemon/src/main.ts) and the unit's
`TimeoutStopSec` in
[`ghostd.service`](../packages/daemon/contrib/ghostd.service) is the
outer bound behind it.

## Send it upstream

The ghost home is one owner's. `packages/`, `CONTRACTS.md`, and `docs/` are
every ghost's, so when a ghost's work there would help every owner, a bug
fixed, a real efficiency gain, a policy line that proved wrong in use, the
policy nudges it to offer the change upstream. It is encouragement, not a
rule: the ghost decides, and you decide at the push. The recipe is
[`CONTRIBUTING.md`](../CONTRIBUTING.md) in the clone:
you set up `gh auth` and a fork remote once, the ghost branches from fetched
`origin/master` before it edits, and it shows you the branch and asks before
it pushes, because the push and the PR go out under your GitHub account.

## Verify

```sh
journalctl --user -t ghostd -n 50
systemctl --user status ghostd
ghost status
```

The daemon logs to journald under `SYSLOG_IDENTIFIER=ghostd`, so `-t ghostd`
catches it whichever unit or launcher started it. `ghost status` prints the
daemon's version, its commit, and the root of the checkout it is running from,
or reports a packaged install when there is no checkout behind it.

## Canary before adopting

Never prove a build by restarting the daemon you depend on. Run a second one
first: a scratch root, a throwaway ghost, a free port.

```sh
mkdir -p /tmp/ghost-canary/ghosts
GHOSTS_ROOT=/tmp/ghost-canary/ghosts \
  bun ~/src/ghost/packages/daemon/dist/main.js --port 7799
```

Point the client at it with `GHOSTD_PORT=7799 ghost status`. Two daemons cannot
share a ghosts root: the second one fails on the home reservation rather than
corrupting the first.

Never port 7717. Never `~/ghosts`. The live daemon holds both, and a canary that
touches either is not a canary.

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

The daemon asks GitHub for the latest release once shortly after boot and
then daily, and `GET /api/status` carries the answer as `update`. `ghost
status` prints it as one line with the exact command for this install
(`omarchy-update` for the package; a pull, build, and restart for a checkout),
the HUD shows the same line above the conversation and copies the command on a
click, and the ghost's policy tells it to say an update is available and to run
that command only when the owner asks. `--offline` skips the check. Nothing
downloads or installs on its own: Omarchy's package pipeline follows Ghost's
releases, and a checkout is the owner's to pull.

## Not built, on purpose

- **No container sandbox with snapshot and rewind.** Ghost runs on the owner's
  real machine. Git, the trash, and snapper already rewind the three layers that
  matter.
- **No rebuild-and-restart tool.** `systemd-run` is the handoff, and the
  runtime's own Bash is how the ghost reaches it.
- **No event-log subsystem.** journald and the conversation transcript are the
  ledger.
- **No self-map beyond `CLAUDE.md` and `CONTRACTS.md`.** A second description of
  the system is a second thing to keep true.
- **No canary automation.** The scratch daemon above is a command you run, not a
  service Ghost operates.
