# Self-maintenance

A ghost can edit, build, and restart the code it runs on. Ghost adds no
machinery for this. The clone is a trusted project like any other, git is the
code history, journald is the lifecycle history, and systemd is the guardian
that survives the daemon it restarts.

Three rules hold the whole thing up:

1. **One clone.** The ghost edits only the checkout named by `self.checkout` in
   its `settings.yml`. Not the packaged install, not a tree it found, not one
   you share with other agents.
2. **A restart is a handoff.** The daemon never restarts itself in process. It
   schedules `systemctl --user restart ghostd.service` in a transient
   `systemd-run --user` unit whose `--description` carries the reason.
3. **History is already written.** `git log` in the checkout for what changed,
   `journalctl --user -t ghostd` for what the daemon did, the conversation
   transcript for why. Read them before retrying a change that failed.

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

## Name the checkout

In `~/ghosts/<name>/settings.yml`:

```yaml
self:
  checkout: /home/<owner>/src/ghost
```

The path must be absolute and under the owner's home. Anything else is ignored
rather than treated as an error. The value is read when a session opens, so a
change applies to new conversations, not to one already running.

Naming the checkout does not grant access to it. Project trust stays explicit:
bind the clone as the conversation's trusted project through the HUD project
chip, the same way you would bind any other project. A ghost cannot bind one for
itself.

## The loop

What the ghost does, once the checkout is bound:

1. Read the clone's `CLAUDE.md` and `CONTRACTS.md` first. They are its self map.
2. Branch, edit, run the touched package tests and `typecheck`.
3. Commit with the reason in the message.
4. `pnpm build`.
5. Tell you it is going down, finish the turn, then schedule the restart.

The restart is one command. It runs in its own transient unit, so the daemon
stopping cannot take the restarter with it:

```sh
systemd-run --user --on-active=5 --unit=ghost-restart-<unix-ts> \
  --description="<reason>" \
  sh -c 'systemctl --user restart ghostd.service; \
         for i in $(seq 30); do ghost status -q && break; sleep 1; done; \
         ghost say --ghost <name> --session <id> "You restarted ghostd for: <reason>. Check journalctl --user -t ghostd and report."'
```

The timestamp in the unit name avoids collisions with an earlier restart still
in the manager. The wait loop covers `Type=simple`, which reports the service
started before the daemon is listening. `--session` sends the wake back into the
conversation that asked for it rather than whichever is newest, and that wake is
how the ghost reports the result to you.

On shutdown the daemon stops admitting work, cancels active turns, waits 5s for
a clean drain, then forces for 2s more. `TimeoutStopSec=10s` and `KillMode=mixed`
in the unit are the outer bound behind that.

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
first, exactly the way [beta-acceptance.md](beta-acceptance.md) builds and
smoke-tests a candidate: a scratch root, a throwaway ghost, a free port.

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

> **A shared tree is not a safe `self.checkout`.** If other agent sessions or
> you edit the same working tree, the ghost's branch, its `git status`, and its
> build will collide with yours, and a restart will ship whatever happened to be
> built last. Give the ghost its own clone.

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
