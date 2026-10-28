// Ghost's summon, as an omarchy-shell panel.
//
// The host owns this plugin's lifecycle: it instantiates this Item when the
// panel is summoned, injects `shell`, and reads `opened` to know what it is
// showing. A plain summon opens the desktop presence's prompt (Presence,
// drawn by Service.qml); a payload naming a section or a conversation opens
// GhostHud, an ordinary xdg-toplevel window Hyprland tiles like any app. This
// file is only the seam between the host's contract and those two.
import QtQuick
import "services"
import "services/Plugin.js" as Plugin

Item {
    id: root

    readonly property string selfId: Plugin.ID

    /**
     * The host's `toggle` hides the panel when this is true and summons it
     * otherwise, so it means "prompt open, or window shown and focused": a HUD
     * open behind other windows or on another workspace is raised by toggle,
     * not hidden.
     */
    property bool opened: Presence.composing || hud.shown && hud.focused()
    /** Injected by the host once the Loader resolves. */
    property var shell: null

    // A rebuild of the host's panel Instantiator destroys and recreates a
    // visibly-open panel; the host's own open flag is what survives, so trust
    // it over this instance's fresh state. `isPluginOpen` is the third-party
    // facade's spelling of that flag (PluginShellApi). A first load is open by
    // that flag too, but its summon is delivered straight after: only a load
    // that no summon follows is a rebuild.
    property bool summoned: false
    onShellChanged: {
        if (hud.shown || !root.shell || !root.shell.isPluginOpen
            || !root.shell.isPluginOpen(root.selfId)) return;
        Qt.callLater(() => {
            if (!root.summoned) root.open('{"section":"chat"}');
        });
    }

    /**
     * Summon. The payload is the shell's summon payload, as Service.qml's IPC
     * verbs and notification actions send it. `{"ghost":"casper"}` selects one
     * first. Without a section or conversation it opens the presence prompt
     * (the window, while there is no ghost to ask);
     * `{"section":"board"}` opens the window on a section, and `sessionId`
     * with `ghost` opens that conversation there.
     */
    function open(payloadJson: string): void {
        root.summoned = true;
        let payload = ({});
        try {
            payload = JSON.parse(payloadJson || "{}") || ({});
        } catch (error) {
            // A malformed payload is still a summon; the window is the point.
        }
        if (payload.ghost && payload.sessionId)
            Ghostd.openConversationForGhost(String(payload.ghost), String(payload.sessionId));
        else if (payload.ghost) Ghostd.selectGhost(String(payload.ghost));
        // No ghost to ask (none yet, or ghostd is down): the window says why.
        if (!payload.section && !payload.sessionId && Ghostd.activeGhost !== "") {
            Presence.summon();
            return;
        }
        Presence.dismiss();
        // The window shows this reply now; the card would only repeat it.
        if (Presence.mine(String(payload.ghost || ""), String(payload.sessionId || ""))) Presence.clear();
        hud.open();
        if (payload.section) hud.showSection(String(payload.section));
    }

    function close(): void {
        Presence.dismiss();
        // A host plugin reload hides every panel before rebuilding it. The
        // owner did not close this one, so the reloaded Service reopens it.
        if (hud.shown && root.shell && root.shell.pluginReloading === true) Ghostd.reopenAfterReload = true;
        hud.close();
    }

    GhostHud {
        id: hud
        // However the window went away (SUPER+W included), the host's own open
        // flag goes too, so a panel rebuild does not reopen what the owner closed.
        // A rebuild's teardown hides the window too; that is not the owner closing it.
        onShownChanged: if (!hud.shown && !root.retiring && root.shell && root.shell.hide) root.shell.hide(root.selfId)
    }
    // The prompt closing (sent or dismissed) is the panel closing, unless
    // the window is still up.
    Connections {
        target: Presence
        function onComposingChanged(): void {
            if (!Presence.composing && !hud.shown && !root.retiring && root.shell && root.shell.hide)
                root.shell.hide(root.selfId);
        }
    }
    property bool retiring: false
    Component.onDestruction: root.retiring = true
}
