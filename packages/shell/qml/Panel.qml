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

    /** The host reads this to know whether the panel is showing. */
    property bool opened: hud.shown
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
     * Summon the window. The payload is the shell's, and carries the same
     * verbs the CLI and the tray used to send: `{"section":"board"}` opens on
     * a section, `{"ghost":"casper"}` selects one first, `{"login":true}`
     * opens the provider login.
     */
    function open(payloadJson: string): void {
        let payload = ({});
        try {
            payload = JSON.parse(payloadJson || "{}") || ({});
        } catch (error) {
            // A malformed payload is still a summon; the window is the point.
        }
        if (payload.ghost) Ghostd.selectGhost(String(payload.ghost));
        hud.open();
        if (payload.section) hud.showSection(String(payload.section));
        if (payload.login) hud.openLogin();
    }

    function close(): void {
        hud.close();
    }

    GhostHud {
        id: hud
    }
}
