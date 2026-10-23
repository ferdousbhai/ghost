// The Ghost chat window, as an omarchy-shell panel.
//
// The host owns this plugin's lifecycle: it instantiates this Item when the
// panel is summoned, injects `shell`, and reads `opened` to know what it is
// showing. Everything visible lives in GhostHud, an ordinary xdg-toplevel
// window Hyprland tiles like any app, so this file is only the seam between
// the host's contract and the HUD's own.
import QtQuick
import "services"

Item {
    id: root

    readonly property string selfId: "ferdousbhai.ghost"

    /**
     * The host's `toggle` hides the panel when this is true and summons it
     * otherwise, so it means "shown and focused": a HUD open behind other
     * windows or on another workspace is raised by toggle, not hidden.
     */
    property bool opened: hud.shown && hud.focused()
    /** Injected by the host once the Loader resolves. */
    property var shell: null

    // A rebuild of the host's panel Instantiator destroys and recreates a
    // visibly-open panel; the host's own open flag is what survives, so trust
    // it over this instance's fresh state. `isPluginOpen` is the third-party
    // facade's spelling of that flag (PluginShellApi).
    onShellChanged: {
        if (!hud.shown && root.shell && root.shell.isPluginOpen
            && root.shell.isPluginOpen(root.selfId))
            root.open("{}")
    }

    /**
     * Summon the window. The payload is the shell's summon payload, as
     * Service.qml's IPC verbs and notification actions send it:
     * `{"section":"board"}` opens on a section, `{"ghost":"casper"}` selects
     * one first. `sessionId` with `ghost` opens that conversation.
     */
    function open(payloadJson: string): void {
        let payload = ({});
        try {
            payload = JSON.parse(payloadJson || "{}") || ({});
        } catch (error) {
            // A malformed payload is still a summon; the window is the point.
        }
        if (payload.ghost && payload.sessionId)
            Ghostd.openConversationForGhost(String(payload.ghost), String(payload.sessionId));
        else if (payload.ghost) Ghostd.selectGhost(String(payload.ghost));
        hud.open();
        if (payload.section) hud.showSection(String(payload.section));
    }

    function close(): void {
        hud.close();
    }

    GhostHud {
        id: hud
        // However the window went away (SUPER+W included), the host's own open
        // flag goes too, so a panel rebuild does not reopen what the owner closed.
        // A rebuild's teardown hides the window too; that is not the owner closing it.
        onShownChanged: if (!hud.shown && !root.retiring && root.shell && root.shell.hide) root.shell.hide(root.selfId)
    }
    property bool retiring: false
    Component.onDestruction: root.retiring = true
}
