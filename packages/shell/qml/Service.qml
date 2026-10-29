// Ghost's always-mounted half: the daemon connection, the desktop presence,
// the notifications a shut window would otherwise swallow, and the `ghost`
// IPC target.
//
// It is a `service` kind so the host mounts it at startup and keeps it
// mounted. The panel is loaded only when summoned, so this is what makes the
// bar dot live, keeps the presence's ticker and card up after its prompt
// closes, and lets a finished turn reach the owner while the window is shut.
import QtQuick
import Quickshell.Io
import "services"
import "services/Plugin.js" as Plugin
import "services/SpeechVoices.js" as Voices

Item {
    id: root

    readonly property string selfId: Plugin.ID

    /** Injected by the host; used to summon and hide this plugin's own panel. */
    property var shell: null

    function summon(payload: var): void {
        if (root.shell && root.shell.summon) root.shell.summon(root.selfId, JSON.stringify(payload || ({})));
    }

    onShellChanged: if (root.shell && Ghostd.reopenAfterReload) {
        Ghostd.reopenAfterReload = false;
        root.summon(({ section: "home" }));
    }

    // `omarchy-shell ghost <verb>`; the plain toggle is the shell's own
    // `toggle ferdousbhai.ghost`.
    IpcHandler {
        objectName: "ghostIpc"
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

        function section(name: string): void {
            root.summon(({ section: name }));
        }

        /**
         * The voices a ghost can answer in, for a ghost setting its own up
         * (`ghost help dictation`): whether Piper is installed, what is
         * downloading, each ghost's choice, and the voices on offer.
         */
        function voices(): string {
            Speech.refresh();
            return JSON.stringify({
                piper: Speech.engine !== "",
                installing: Speech.installing,
                error: Speech.installError,
                chosen: Speech.choices,
                voices: Voices.offered(Speech.installed).map(voice => ({
                    id: voice.id, name: voice.name, detail: voice.detail, installed: voice.installed
                }))
            });
        }

        /**
         * Give `ghost` the voice `id`, downloading it first if it is not
         * installed, or `off` for silence. Says what it did.
         */
        function voice(ghost: string, id: string): string {
            if (ghost === "") return "name the ghost";
            if (id === "" || id === "off") {
                Speech.choose(ghost, "");
                return ghost + " is silent";
            }
            if (Speech.installed.indexOf(id) >= 0) {
                Speech.choose(ghost, id);
                return ghost + " speaks in " + id;
            }
            if (Voices.modelUrl(id) === "") return "unknown voice " + id + "; `omarchy-shell ghost voices` lists them";
            if (Speech.installing !== "") return "already downloading " + Speech.installing + "; ask again when it is done";
            Speech.install(id, ghost);
            return "downloading " + id + " for " + ghost + "; `omarchy-shell ghost voices` shows when it is done";
        }

        function status(): string {
            return JSON.stringify({
                ghost: Ghostd.activeGhost,
                shown: Ghostd.hudVisible,
                streaming: Ghostd.streaming,
                reachable: Ghostd.reachable,
                activity: Ghostd.activity,
                error: Ghostd.lastError,
                summonKey: desktopKeys.summonKey
            });
        }

        function refresh(): void {
            Ghostd.refresh();
            Theme.reload();
        }
    }

    /** The reply is on screen already: in the focused chat, or as the presence card. */
    function viewing(ghost: string, sessionId: string): bool {
        return Presence.mine(ghost, sessionId) || Ghostd.hudChatFocused && Ghostd.activeGhost === ghost
            && Ghostd.currentSessionId === sessionId;
    }

    PresenceOverlay {}

    DesktopKeys {
        id: desktopKeys
    }

    Connections {
        target: Presence

        function onWindowRequested(ghost: string, sessionId: string): void {
            root.summon(({ ghost: ghost, sessionId: sessionId, section: "chat" }));
        }
    }

    Connections {
        target: Ghostd

        function onTurnFinished(ghost: string, text: string, sessionId: string, title: string): void {
            if (!root.viewing(ghost, sessionId)) Notifier.turnFinished(ghost, sessionId, title, text);
        }

        function onTurnFailed(ghost: string, message: string, sessionId: string, title: string): void {
            if (!root.viewing(ghost, sessionId)) Notifier.turnFailed(ghost, sessionId, title, message);
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
