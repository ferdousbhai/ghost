import QtQuick
import Quickshell
import Quickshell.Hyprland
import "./qml" as Ghost
import "./qml/services" as Services

// Run only inside dev/preview.sh's private environment, with its mock daemon.
ShellRoot {
    id: root
    readonly property bool isolated: (Quickshell.env("XDG_RUNTIME_DIR") || "").startsWith("/tmp/ghp.")
        && Number(Quickshell.env("GHOSTD_PORT")) > 0
        && Number(Quickshell.env("GHOSTD_PORT")) <= 65535
        && Quickshell.env("GHOSTD_PORT") !== "7717"
    property int step: 0
    property int attempts: 0
    Ghost.GhostHud { id: hud; shown: root.isolated; title: "Ghost focus validation" }
    FloatingWindow {
        id: peer
        title: "Focus regression peer"
        visible: root.isolated
        implicitWidth: 320
        implicitHeight: 200
    }
    Component.onCompleted: {
        if (!root.isolated) { console.error("Refusing the owner's desktop"); Qt.exit(1); }
    }
    Timer {
        interval: 100
        repeat: true
        running: root.isolated
        onTriggered: {
            root.attempts++;
            if (root.attempts > 100) { console.error("Focus probe timed out at step " + root.step); Qt.exit(1); }
            if (root.step === 0) {
                Hyprland.dispatch('hl.dsp.focus({ window = "title:^Ghost focus validation$" })');
                root.step = 1;
            } else if (root.step === 1 && hud.contentItem.Window.active) {
                if (!hud.focused() || !Services.Ghostd.hudChatFocused) {
                    console.error("Focused chat was not recognized"); Qt.exit(1); return;
                }
                console.log("PASS focused Chat recognizes its own active window");
                Hyprland.dispatch('hl.dsp.focus({ window = "title:^Focus regression peer$" })');
                root.step = 2;
            } else if (root.step === 2 && peer.contentItem.Window.active) {
                if (hud.focused() || Services.Ghostd.hudChatFocused) {
                    console.error("Unfocused chat was marked focused"); Qt.exit(1); return;
                }
                console.log("PASS unfocused Chat retains unread policy");
                hud.showSection("board");
                Hyprland.dispatch('hl.dsp.focus({ window = "title:^Ghost focus validation$" })');
                root.step = 3;
            } else if (root.step === 3 && hud.contentItem.Window.active) {
                if (!hud.focused() || Services.Ghostd.hudChatFocused) {
                    console.error("Focused Board was treated as Chat"); Qt.exit(1); return;
                }
                console.log("PASS focused Board is not focused Chat");
                Qt.quit();
            }
        }
    }
}
