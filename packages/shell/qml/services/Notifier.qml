pragma Singleton

// Desktop toasts use notify-send; Quickshell's notification API is server-only.
import Quickshell
import Quickshell.Io
import QtQuick
import "NotificationText.js" as NotificationText

Singleton {
    id: root

    property bool enabled: true

    property var notificationIds: ({})
    property var pending: []
    property string sendingKey: ""

    Process {
        id: sender
        objectName: "notificationSender"
        stdout: SplitParser {
            onRead: data => {
                const id = Number(data.trim());
                if (Number.isInteger(id) && id > 0) root.notificationIds[root.sendingKey] = id;
            }
        }
        onRunningChanged: if (!running) Qt.callLater(root.drain)
    }

    /** Wait for the server ID before sending a replacement for the same conversation. */
    function drain(): void {
        if (sender.running || root.pending.length === 0) return;
        const next = root.pending.shift();
        root.sendingKey = JSON.stringify([next.ghost, next.sessionId]);
        sender.command = NotificationText.command(next.ghost, next.sessionId, next.title,
            next.body, next.urgency, root.notificationIds[root.sendingKey]);
        sender.running = true;
    }

    function send(ghost: string, sessionId: string, title: string, body: string, urgency: string): void {
        if (!root.enabled) return;
        root.pending = root.pending.filter(item => item.ghost !== ghost || item.sessionId !== sessionId);
        root.pending.push({ ghost: ghost, sessionId: sessionId, title: title, body: body, urgency: urgency });
        root.drain();
    }

    function askWaiting(ghost: string, sessionId: string, title: string, ask: var): void {
        root.send(ghost, sessionId, title, NotificationText.askBody(ask), "normal");
    }

    function turnFinished(ghost: string, sessionId: string, title: string, text: string): void {
        root.send(ghost, sessionId, title, text.trim() === "" ? "Finished its turn" : text, "normal");
    }

    function turnFailed(ghost: string, sessionId: string, title: string, message: string): void {
        root.send(ghost, sessionId, title, message, "critical");
    }
}
