pragma Singleton

// Notifier — desktop notifications for turns that finish while the HUD is shut.
//
// Quickshell.Services.Notifications is a *server* API: it receives
// notifications and every field on `Notification` is readonly. There is no
// send/post/create anywhere in it. So v1 shells out to notify-send, which is
// what Omarchy's own scripts do and costs nothing when nobody is listening.
//
// execDetached rather than a Process object: fire-and-forget, no lifecycle to
// leak if a burst of turns finish at once.
import Quickshell
import QtQuick
import "NotificationText.js" as NotificationText

Singleton {
    id: root

    property bool enabled: true

    readonly property int excerptLength: 180

    function excerpt(text: string): string {
        const flat = text.replace(/\s+/gu, " ").trim();
        return flat.length > root.excerptLength
            ? flat.slice(0, root.excerptLength - 1) + "…"
            : flat;
    }

    /**
     * `urgency` is one of "low", "normal", "critical".
     * Notifications are replaced in place per ghost via the synchronous hint,
     * so a chatty ghost cannot bury the rest of the user's notification stack.
     */
    function send(ghost: string, body: string, urgency: string): void {
        if (!root.enabled) return;
        Quickshell.execDetached([
            "notify-send",
            "--app-name=ghost",
            "--urgency=" + urgency,
            // Omarchy persists this hint with the toast and runs it on click.
            // Other notification servers ignore unknown freedesktop hints.
            "--hint=string:omarchy-exec:omarchy-shell shell summon ferdousbhai.ghost {}",
            "--hint=string:x-canonical-private-synchronous:ghost-" + ghost,
            ghost,
            root.excerpt(body)
        ]);
    }

    function askWaiting(ghost: string, ask: var): void {
        root.send(ghost, NotificationText.askBody(ask), "normal");
    }

    function turnFinished(ghost: string, text: string): void {
        root.send(ghost, text === "" ? "finished its turn" : text, "normal");
    }

    function turnFailed(ghost: string, message: string): void {
        root.send(ghost, message, "critical");
    }
}
