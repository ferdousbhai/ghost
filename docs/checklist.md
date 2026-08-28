# Owner checklist

Two lists. The first is the smoke pass: what only a real run can tell us.
Everything in it is covered by tests or by an isolated preview, but none of it
has met the owner's own ghost, their own conversations, or a real model. Work
down it after restarting the daemon and the shell; each item names what to look
for and what it would mean if it looks wrong. The second is what remains on the
beta gate (#17) that only the owner can do.

```sh
systemctl --user restart ghostd     # picks up the daemon changes
qs -p ~/.config/quickshell/ghost/shell.qml kill   # then start it again as usual
```

## Smoke pass

### Turn lifecycle

- [ ] **Steering appears live.** Start a long, tool-heavy turn, then steer it
      mid-flight. The steered text must join the transcript at the moment the
      ghost consumes it, in order, without reopening the conversation. It moves
      out of the queue line as it lands. This is the bug that started the work:
      the daemon was dropping the harness's owner-authored dequeue event.
- [ ] **A turn ends when it ends.** After the final answer, the orb stops, the
      composer returns, and nothing keeps streaming. A turn that looks finished
      but still says it is working means a terminal event went missing.
- [ ] **Clicking the open conversation mid-turn does nothing.** It used to
      cancel the stream and then report the daemon as unreachable.
- [ ] **Cancel with Esc** stops the turn and leaves the conversation usable.

### Several conversations at once

- [ ] **Two threads answer together.** Start a turn, switch to another
      conversation, start a second turn. Neither cancels the other; both finish.
- [ ] **Switching detaches.** Going back to the first thread shows its progress
      where it got to, not a restart and not a blank transcript.
- [ ] **A thread that finishes while you are elsewhere** ends up unread and
      climbs the sidebar on its own, with no click to make it happen.

### Sidebar

- [ ] **Unread dot** is amber, sits at the right of the row, and disappears once
      you open that conversation. The conversation you are looking at never
      shows one, even when its turn lands while you watch.
- [ ] **Rows reorder visibly** as threads update, rather than teleporting.
- [ ] **Rename a conversation** by double-clicking its title. Enter commits, Esc
      cancels, an emptied field cancels rather than clearing the name. The new
      name survives a daemon restart, and the background titler never overwrites
      it.

### Tray

- [ ] **Right-click the tray icon.** No "Summon" entry. With one ghost, no radio
      list. Five recent conversations, unread ones marked with a bullet.
- [ ] **Clicking a conversation** opens the HUD on that conversation directly.
- [ ] **New conversation** starts an empty thread.
- [ ] **Quit** says it closes the shell, and does exactly that while the daemon
      keeps running.

### Ghosts, models, asks

- [ ] **Rename a ghost.** Its conversations, pins and memory come with it;
      shared Documents remain unchanged and available. Legacy docs inside an
      imported ghost home stay import-only and move with that home. Every
      conversation still opens. A login started before the rename still
      completes afterwards.
- [ ] **Branch a message.** It creates a copy named `<title> (2)`, rewound to
      before that message, with its text in the composer. The original is
      untouched, and both threads appear in the sidebar.
- [ ] **Message actions stay out of the way.** The edit pencil is absent until
      hovering a user message, then appears with clear space after and aligned
      to the final text line. The copy icon on ghost replies keeps the same gap,
      including when either action wraps below the text.
- [ ] **Pick a model for a provider you have not logged into.** The switcher
      shows it dimmed as "waiting for login" rather than showing nothing, and
      clears once the login finishes or the panel closes.
- [ ] **Migrate an old credential home.** On first session open, legacy
      `.pi/auth.json` is removed (and an older home's `.pi/agent.db` is scrubbed
      and vacuumed), `models.json` contains `keyring:` references,
      and the next turn still works. Lock a passworded keyring and try again:
      session open must report a keyring error, with no plaintext fallback. A
      blank-password login keyring cannot be observed locked; that case is
      covered by tests only (see `docs/keyring.md`).
- [ ] **Let idle memory maintenance run.** Give the ghost one durable fact,
      finish the turn, and leave it idle; the memory write appears after the
      60-second deadline. Ordinary upkeep stays single-write below pressure;
      consolidation runs only at a 3,200-character index, an omitted entry, or
      100 valid files, and its deletions remain recoverable.
- [ ] **Let an ask time out.** Until 30s remain there is a static line saying it
      answers itself; then a seconds countdown, amber for the last 10. If the
      question carried a recommendation it is taken and the card offers to
      change it; if it did not, nothing is chosen and the card says so.
- [ ] **Screenshots still come back as images** under a Claude Code
      conversation, not as text descriptions.

### If something is wrong

The daemon logs to the journal (`journalctl --user -u ghostd -f`). For the shell,
run it from a terminal and watch stderr; QML type errors and failed bindings
print there. Reproduce against the mock with `dev/preview.sh` rather than
debugging on the live desktop.

## Beta release (#17), owner steps

Done and recorded on #17: scope frozen at `v0.1.0`, #23 shipped, #37 covered,
docs synced, packaging fixed, Arch CI green on `8332ba0`. What is left needs a
person, a second machine, or a hosted account.

### Release candidate

- [ ] **Smoke pass above, on the real desktop.** Every box, on the build that
      will be tagged. The graphical items (HUD, tray, provider login and model
      switch, Claude Code, browser relay, dedicated browser, desktop helper,
      restart, upgrade) cannot be driven headless.
- [ ] **Clean machine.** On a fresh Arch/Omarchy install or VM: install the
      package, create a ghost, talk to it; upgrade over it; uninstall; reinstall
      and confirm the ghost home was never touched. `gnome-keyring` must be
      running before the first session (`libsecret` is a package dependency).
- [ ] **Re-confirm CI on the tagged commit.** Green on `8332ba0` is not green on
      the tag; anything that lands between them reruns the workflow.
- [ ] **Version bump, tag, release, AUR.** Bump every public package/manifest
      version consistently, tag `v0.1.0`, publish the GitHub release, inspect the
      sealed assets, then publish or update the AUR recipe. The bump commit can
      be prepared ahead of time; the tag and publish are the last acts.

### Hosted migration handoff

- [ ] **Real export.** From an eligible summonghost.com account, `/account` →
      "Download my ghost". Confirm `ghost-home/v1`, the expected character,
      memory, and docs, and no credentials; import into the release build and
      open a conversation.
- [ ] **summon-ghost #552 and #551.** Reproduce or clear both. If the failure is
      still opaque, verify the hosted sourcemap upload from summon-ghost #463
      before debugging further.
- [ ] **Announcement.** Only after a public install link and a verified import
      exist: send the one-time migration announcement to the 43 snapshotted
      signups from a verified platform sender, record exactly-once delivery,
      respect retry and rate-limit failures.
- [ ] **Hand off decommissioning.** The hosted chat API and downstream
      consumers move to post-beta #29.

### Exit

- [ ] CI and the smoke pass are green on the tagged commit.
- [ ] Release assets and the AUR install are tested.
- [ ] A real hosted export imports with the expected data and no credentials.
- [ ] The announcement went out exactly once, with a retained delivery record.
