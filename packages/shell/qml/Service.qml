// Ghost's headless half: the daemon connection, the notifications a shut
// window would otherwise swallow, and the `ghost` IPC target.
//
// It is a `service` kind so the host mounts it at startup and keeps it
// mounted. The panel is loaded only when summoned, so this is what makes the
// bar dot live and a finished turn reach the owner while the window is shut.
import QtQuick
import Quickshell
import Quickshell.Io
import "services"

Item {
    id: root

    readonly property string selfId: "ferdousbhai.ghost"

    /** Injected by the host; used to summon and hide this plugin's own panel. */
    property var shell: null

    // An ask is polled while its provider turn remains open. Remember the id
    // so a reconnect or repeated property assignment cannot raise two toasts.
    property string announcedAskId: ""

    /**
     * Whether the window is up, asked of the host at the moment it matters.
     * The third-party facade exposes this as a call rather than a property
     * (PluginShellApi), so it cannot be a binding; every caller here is an
     * event handler, which is the only place the answer is needed.
     */
    function panelShown(): bool {
        return Boolean(root.shell && root.shell.isPluginOpen && root.shell.isPluginOpen(root.selfId));
    }

    function summon(payload: var): void {
        if (root.shell && root.shell.summon) root.shell.summon(root.selfId, JSON.stringify(payload || ({})));
    }

    // `omarchy-shell ghost <verb>`; the shell's own `toggle ferdousbhai.ghost`
    // covers the plain summon, so these are the verbs that carry an argument.
    IpcHandler {
        target: "ghost"

        function open(): void {
            root.summon(({}));
        }

        function close(): void {
            if (root.shell && root.shell.hide) root.shell.hide(root.selfId);
        }

        function summon(name: string): void {
            root.summon(name === "" ? ({}) : ({ ghost: name }));
        }

        function ask(prompt: string): void {
            Ghostd.send(prompt);
        }

        function login(): void {
            root.summon(({ login: true }));
        }

        function section(name: string): void {
            root.summon(({ section: name }));
        }

        function loginTo(provider: string, authType: string): void {
            root.summon(({ login: true }));
            if (provider !== "") Ghostd.startLogin(provider, authType === "" ? "oauth" : authType);
        }

        function status(): string {
            return JSON.stringify({
                ghost: Ghostd.activeGhost,
                shown: root.panelShown(),
                streaming: Ghostd.streaming,
                reachable: Ghostd.reachable,
                activity: Ghostd.activity,
                error: Ghostd.lastError
            });
        }

        function refresh(): void {
            Ghostd.refresh();
            Theme.reload();
        }
    }

    // Only when the window is shut. If the owner is looking at the stream, a
    // toast saying what they just watched arrive is noise.
    Connections {
        target: Ghostd

        function onTurnFinished(ghost: string, text: string): void {
            if (!root.panelShown()) Notifier.turnFinished(ghost, text);
        }

        function onTurnFailed(ghost: string, message: string): void {
            if (!root.panelShown()) Notifier.turnFailed(ghost, message);
        }

        function onPendingAskChanged(): void {
            const ask = Ghostd.pendingAsk;
            if (!ask) {
                root.announcedAskId = "";
                return;
            }
            const askId = String(ask.id || "");
            if (askId !== "" && askId === root.announcedAskId) return;
            root.announcedAskId = askId;
            if (!root.panelShown()) Notifier.askWaiting(Ghostd.activeGhost, ask);
        }
    }

    // ghostd may well start after the shell does. Retry the roster until it
    // answers, then stop.
    Timer {
        interval: 4000
        running: !Ghostd.reachable
        repeat: true
        onTriggered: Ghostd.refresh()
    }
}
