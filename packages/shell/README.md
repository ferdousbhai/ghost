# `@ghost/shell`

Ghost's Omarchy-native Quickshell client: chat HUD, persistent bar indicator,
tray item, settings/context panels, and notifications.

The HUD is a normal `FloatingWindow` (`xdg-toplevel`, app-id `ghost`), so
Hyprland owns tiling, focus, resizing, and workspace movement. Persistent bar
and tray surfaces remain in the layer/SNI world. `SUPER+CTRL+G` is
launch-or-focus, hiding only when the focused HUD receives it again.

## Code map

```text
qml/shell.qml             process entry and surfaces
qml/GhostHud.qml          chat window
qml/GhostBarWidget.qml    embeddable status widget
qml/TrayBridge.qml        StatusNotifier bridge
qml/components/           chat, ask, jobs, queue, tools, routing, orb
qml/services/Ghostd.qml   authenticated HTTP/SSE client and UI state
contrib/                  Omarchy integration
dev/                      isolated preview, mock daemon, checks
```

Install integration lives in [`contrib/README.md`](contrib/README.md). Preview
and fixture options live in [`dev/README.md`](dev/README.md). Stable wire and
storage behavior lives in [`CONTRACTS.md`](../../CONTRACTS.md).

## UI boundaries

- One `Ghostd` singleton serves HUD and in-process bar state. It parses
  cumulative QML `XMLHttpRequest` SSE bodies directly; request objects remain
  strongly owned until terminal settlement.
- The shell edits durable state only through authenticated daemon routes. It
  never reads ghost homes or Obsidian vault files directly.
- `ask` replaces the composer while owner input is pending. It is not tool
  approval. Enter answers, Escape dismisses, and restored cards preserve how a
  question settled.
- While streaming, Enter steers, Ctrl+Enter queues a follow-up, and Shift+Enter
  inserts a newline.
- The work strip is background-job control only: bounded output, status, cancel,
  and visible-HUD polling while work runs. Plans and tasks live in Obsidian; the
  shell has no plan mode or progress/todo projection.
- Tool activity is transient beside the orb. Settled replies keep failed calls
  and asks visible by default; the complete trace is available behind the steps
  disclosure.
- Project binding is explicit. An unpublished bound draft must be abandoned
  through ghostd before selection changes; a failed abandon keeps it selected.
- Context panels expose character, private memory, commands, hooks, MCP, model
  routing, remote access, and connection state. Memory deletion is confirmed
  and recoverable.

## Verification

Never launch a plain development Quickshell process on the owner's session bus.
Use the isolated nested compositor:

```sh
packages/shell/dev/preview.sh
```

Run lint and the QML suite with:

```sh
pnpm --filter @ghost/shell lint
pnpm --filter @ghost/shell test
```

The test harness maps daemon traffic to destination port 0 and uses private
imports/state, so it cannot contact the live service. Preview helpers capture
and stop only PIDs they start.
