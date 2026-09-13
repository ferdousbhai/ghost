pragma ComponentBehavior: Bound

// TrayBridge — puts the ghost in the system tray as a StatusNotifierItem.
//
// Quickshell 0.3.0 can *consume* an SNI (Quickshell.Services.SystemTray) but
// exposes no way to *produce* one — no generic D-Bus object/adaptor anywhere in
// its QML surface. So the actual org.kde.StatusNotifierItem + com.canonical.
// dbusmenu objects live in a tiny helper, qml/tray/ghost-tray.py, and this
// component is the seam between it and the shell.
//
// It owns and supervises the helper's lifecycle, with bounded retry after a
// crash and no stale process when the shell exits. State flows one way down the
// helper's stdin (a JSON line whenever Ghostd/Theme change) and intents flow
// the other way up its stdout, where they become the same calls SUPER+CTRL+G or
// a menu click would make. The helper never talks to ghostd; all ghost state
// stays in the one Ghostd singleton the HUD already drives.
import Quickshell
import Quickshell.Io
import QtQuick
import "services"
import "TrayActions.js" as TrayActions

Item {
    id: bridge

    /** The HUD actions are routed to; set by shell.qml. */
    property var hud

    /** Observable lifecycle state for diagnostics and tests. */
    property string helperState: "starting"
    property string helperError: ""
    property bool helperWasStarted: false
    property int consecutiveFailures: 0

    // Kept configurable so lifecycle tests prove the real timers without
    // sleeping for production delays.
    property int restartBaseDelayMs: 1000
    property int restartMaxDelayMs: 30000
    property int stableRunWindowMs: 30000
    property int startupTimeoutMs: 2000

    // The state the tray reflects, re-serialised whenever any input changes.
    // Theme colours ride along so the icon is tinted to whatever Omarchy wears.
    readonly property string payload: JSON.stringify({
        reachable: Ghostd.reachable,
        streaming: Ghostd.anyStreaming,
        activeGhost: Ghostd.activeGhost,
        activity: Ghostd.activity,
        ghosts: bridge.roster(),
        sessions: bridge.recentSessions(),
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

    function recentSessions(): var {
        return Ghostd.sessions.slice().sort(function (a, b) {
            return (Date.parse(b.updatedAt || b.createdAt || "") || 0)
                - (Date.parse(a.updatedAt || a.createdAt || "") || 0);
        }).slice(0, 5).map(function (session) {
            return {
                id: session.id,
                title: session.title,
                unread: session.unread === true
            };
        });
    }

    function push(): void {
        if (helper.running) helper.write(bridge.payload + "\n");
    }

    function startHelper(): void {
        restartTimer.stop();
        bridge.helperState = "starting";
        bridge.helperWasStarted = false;
        helper.running = true;
        startupWatchdog.restart();
    }

    function helperStarted(): void {
        startupWatchdog.stop();
        bridge.helperWasStarted = true;
        bridge.helperState = "running";
        bridge.helperError = "";
        stableRunTimer.restart();
        bridge.push();
    }

    function restartDelay(): int {
        const exponent = Math.min(bridge.consecutiveFailures, 30);
        return Math.min(bridge.restartMaxDelayMs,
            bridge.restartBaseDelayMs * Math.pow(2, exponent));
    }

    function scheduleRestart(): void {
        startupWatchdog.stop();
        stableRunTimer.stop();
        const delay = bridge.restartDelay();
        bridge.consecutiveFailures += 1;
        bridge.helperState = "restarting";
        bridge.helperError = "System tray helper stopped unexpectedly; retrying in "
            + Math.ceil(delay / 1000) + " seconds.";
        console.warn("ghost:", bridge.helperError);
        restartTimer.interval = delay;
        restartTimer.restart();
    }

    function markUnavailable(message: string): void {
        startupWatchdog.stop();
        stableRunTimer.stop();
        restartTimer.stop();
        bridge.helperState = "unavailable";
        bridge.helperError = message;
        helper.running = false;
        console.warn("ghost:", message);
        Notifier.send("ghost", message, "critical");
    }

    function helperStopped(): void {
        if (!bridge.helperWasStarted) return;
        bridge.helperWasStarted = false;
        if (bridge.helperState !== "unavailable") bridge.scheduleRestart();
    }

    function handleStderr(line: string): void {
        const prefix = "ghost-tray-error:";
        const text = line.trim();
        if (!text.startsWith(prefix)) {
            console.warn("ghost-tray:", line);
            return;
        }
        try {
            const diagnostic = JSON.parse(text.slice(prefix.length));
            if (diagnostic.kind === "dependency" && diagnostic.message) {
                if (diagnostic.detail) console.warn("ghost-tray:", diagnostic.detail);
                bridge.markUnavailable(String(diagnostic.message));
                return;
            }
        } catch (error) {
            // Fall through to the raw helper diagnostic.
        }
        console.warn("ghost-tray:", line);
    }

    Component.onCompleted: bridge.startHelper()

    Timer {
        id: restartTimer
        objectName: "trayRestartTimer"
        repeat: false
        onTriggered: bridge.startHelper()
    }

    Timer {
        id: stableRunTimer
        objectName: "trayStableRunTimer"
        interval: bridge.stableRunWindowMs
        repeat: false
        onTriggered: bridge.consecutiveFailures = 0
    }

    Timer {
        id: startupWatchdog
        objectName: "trayStartupWatchdog"
        interval: bridge.startupTimeoutMs
        repeat: false
        onTriggered: bridge.markUnavailable(
            "Could not start the system tray helper. Install Python with "
            + "`sudo pacman -S --needed python`, then restart the ghost shell.")
    }

    Process {
        id: helper
        objectName: "trayHelper"
        command: ["python3", Quickshell.shellPath("tray/ghost-tray.py")]
        running: false
        stdinEnabled: true

        onStarted: bridge.helperStarted()
        // Quickshell does not export the QProcess::ExitStatus type used by its
        // exited signal. The running transition after a confirmed start is the
        // same lifecycle boundary and remains lintable QML.
        onRunningChanged: if (!helper.running) bridge.helperStopped()

        stdout: SplitParser {
            onRead: line => bridge.dispatch(line)
        }
        stderr: SplitParser {
            onRead: line => bridge.handleStderr(line)
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
        if (!TrayActions.dispatch(message, Ghostd, bridge.hud, function () { Qt.quit(); }))
            console.warn("ghost: unknown tray action:", message.action);
    }
}
