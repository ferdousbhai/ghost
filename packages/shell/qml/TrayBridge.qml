pragma ComponentBehavior: Bound

// TrayBridge — puts the ghost in the system tray as a StatusNotifierItem.
//
// Quickshell 0.3.0 can *consume* an SNI (Quickshell.Services.SystemTray) but
// exposes no way to *produce* one — no generic D-Bus object/adaptor anywhere in
// its QML surface. So the actual org.kde.StatusNotifierItem + com.canonical.
// dbusmenu objects live in a tiny helper, qml/tray/ghost-tray.py, and this
// component is the seam between it and the shell.
//
// It owns the helper's lifecycle: the Process starts with the shell and Qt
// reaps it when the shell exits, so the tray icon is present exactly when the
// shell is running — no watcher, no stale icon. State flows one way down the
// helper's stdin (a JSON line whenever Ghostd/Theme change) and intents flow
// the other way up its stdout, where they become the same calls SUPER+G or a
// menu click would make. The helper never talks to ghostd; all ghost state
// stays in the one Ghostd singleton the HUD already drives.
import Quickshell
import Quickshell.Io
import QtQuick
import qs.services

Item {
    id: bridge

    /** The HUD actions are routed to; set by shell.qml. */
    property var hud

    // The state the tray reflects, re-serialised whenever any input changes.
    // Theme colours ride along so the icon is tinted to whatever Omarchy wears.
    readonly property string payload: JSON.stringify({
        reachable: Ghostd.reachable,
        streaming: Ghostd.streaming,
        activeGhost: Ghostd.activeGhost,
        activity: Ghostd.activity,
        ghosts: bridge.roster(),
        colors: {
            idle: String(Theme.foreground),
            streaming: String(Theme.accent),
            danger: String(Theme.danger)
        }
    })

    onPayloadChanged: bridge.push()

    function roster(): var {
        const out = [];
        for (const ghost of Ghostd.ghosts)
            if (ghost && ghost.name) out.push({ name: ghost.name });
        return out;
    }

    function push(): void {
        if (helper.running) helper.write(bridge.payload + "\n");
    }

    Process {
        id: helper
        command: ["python3", Quickshell.shellPath("tray/ghost-tray.py")]
        running: true
        stdinEnabled: true

        // Push the first snapshot once the helper is up and reading. onExited is
        // deliberately unhandled: its QProcess::ExitStatus parameter has no QML
        // type export and makes the handler noisy under qmllint (see
        // dev/README.md). If the helper dies, its tray icon simply disappears.
        onStarted: bridge.push()

        stdout: SplitParser {
            onRead: line => bridge.dispatch(line)
        }
        stderr: SplitParser {
            onRead: line => console.warn("ghost-tray:", line)
        }
    }

    // An intent from the tray: left-click, or a DBusMenu choice.
    function dispatch(line: string): void {
        const text = line.trim();
        if (text === "") return;
        let message;
        try {
            message = JSON.parse(text);
        } catch (error) {
            console.warn("ghost: unparseable tray action:", text);
            return;
        }
        switch (message.action) {
        case "toggle":
            bridge.hud.toggle();
            break;
        case "open":
            bridge.hud.open();
            break;
        case "summon":
            if (message.name) Ghostd.selectGhost(message.name);
            bridge.hud.open();
            break;
        case "login":
            bridge.hud.open();
            bridge.hud.openLogin();
            break;
        case "quit":
            Qt.quit();
            break;
        default:
            console.warn("ghost: unknown tray action:", message.action);
        }
    }
}
