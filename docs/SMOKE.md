# Smoke checklist

What only a real run can tell us. Everything below is covered by tests or by an
isolated preview, but none of it has met the owner's own ghost, their own
conversations, or a real model. Work down the list after restarting the daemon
and the shell; each item names what to look for and what it would mean if it
looks wrong.

```sh
systemctl --user restart ghostd     # picks up the daemon changes
qs -p ~/.config/quickshell/ghost/shell.qml kill   # then start it again as usual
```

## Turn lifecycle

- [ ] **Steering appears live.** Start a long, tool-heavy turn, then steer it
      mid-flight. The steered text must join the transcript at the moment the
      ghost consumes it, in order, without reopening the conversation. It moves
      out of the queue line as it lands. This is the bug that started the work:
      the daemon was dropping OMP's owner-authored dequeue event.
- [ ] **A turn ends when it ends.** After the final answer, the orb stops, the
      composer returns, and nothing keeps streaming. A turn that looks finished
      but still says it is working means a terminal event went missing.
- [ ] **Clicking the open conversation mid-turn does nothing.** It used to
      cancel the stream and then report the daemon as unreachable.
- [ ] **Cancel with Esc** stops the turn and leaves the conversation usable.

## Several conversations at once

- [ ] **Two threads answer together.** Start a turn, switch to another
      conversation, start a second turn. Neither cancels the other; both finish.
- [ ] **Switching detaches.** Going back to the first thread shows its progress
      where it got to, not a restart and not a blank transcript.
- [ ] **A thread that finishes while you are elsewhere** ends up unread and
      climbs the sidebar on its own, with no click to make it happen.

## Sidebar

- [ ] **Unread dot** is amber, sits at the right of the row, and disappears once
      you open that conversation. The conversation you are looking at never
      shows one, even when its turn lands while you watch.
- [ ] **Rows reorder visibly** as threads update, rather than teleporting.
- [ ] **Rename a conversation** by double-clicking its title. Enter commits, Esc
      cancels, an emptied field cancels rather than clearing the name. The new
      name survives a daemon restart, and the background titler never overwrites
      it.

## Tray

- [ ] **Right-click the tray icon.** No "Summon" entry. With one ghost, no radio
      list. Five recent conversations, unread ones marked with a bullet.
- [ ] **Clicking a conversation** opens the HUD on that conversation directly.
- [ ] **New conversation** starts an empty thread.
- [ ] **Quit** says it closes the shell, and does exactly that while the daemon
      keeps running.

## Ghosts, models, asks

- [ ] **Rename a ghost.** Its conversations, pins, memory and docs come with it;
      every conversation still opens. A login started before the rename still
      completes afterwards.
- [ ] **Branch a message.** It creates a copy named `<title> (2)`, rewound to
      before that message, with its text in the composer. The original is
      untouched, and both threads appear in the sidebar.
- [ ] **Pick a model for a provider you have not logged into.** The switcher
      shows it dimmed as "waiting for login" rather than showing nothing, and
      clears once the login finishes or the panel closes.
- [ ] **Let an ask time out.** Until 30s remain there is a static line saying it
      answers itself; then a seconds countdown, amber for the last 10. If the
      question carried a recommendation it is taken and the card offers to
      change it; if it did not, nothing is chosen and the card says so.
- [ ] **Screenshots still come back as images** under a Claude Code
      conversation, not as text descriptions.

## If something is wrong

The daemon logs to the journal (`journalctl --user -u ghostd -f`). For the shell,
run it from a terminal and watch stderr; QML type errors and failed bindings
print there. Reproduce against the mock with `dev/preview.sh` rather than
debugging on the live desktop.
