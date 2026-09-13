// GhostBarWidget — the ghost mascot and the active ghost's name, sized for
// Omarchy's bar. This is the plugin's `bar-widget` entry point.
//
// It runs in the same process as the panel, so it reads the same Ghostd
// singleton the window does: the glyph reacts the instant a turn starts, with
// no polling and no second connection to the daemon.
//
// The mark is GhostGlyph, the same lucide ghost the HUD's header and hero draw,
// so the bar and the window are one piece of artwork at two sizes. State is
// carried by its tint and by the orb that glows behind it while a turn runs,
// not by a separate indicator.
import QtQuick
import "services"
import "components"

Item {
    id: root

    /**
     * Injected by the host bar. Omarchy themes its bar as a whole, so its
     * foreground and font win over our own tokens when the widget is hosted;
     * the fallbacks keep it drawable outside a bar.
     */
    property var bar: null

    readonly property color foregroundColor: root.bar && root.bar.foreground
        ? root.bar.foreground : Theme.barForeground
    readonly property string fontFamily: root.bar && root.bar.fontFamily
        ? root.bar.fontFamily : Theme.fontFamily

    /**
     * Injected by the host, the same capability-scoped facade the panel and
     * service get. Clicking the mascot toggles this plugin's own window
     * through it; the signal stays for a caller that wants to do something
     * else with the click.
     */
    property var shell: null

    readonly property string selfId: "ferdousbhai.ghost"

    property bool showName: true

    signal activated()

    function toggleWindow(): void {
        if (root.shell && root.shell.toggle) root.shell.toggle(root.selfId, "{}");
        root.activated();
    }

    readonly property string status: !Ghostd.reachable
        ? "offline"
        : (Ghostd.streaming ? (Ghostd.activity !== "" ? Ghostd.activity : "thinking") : "idle")

    // Unreachable is the one state worth a colour of its own. Otherwise the
    // ghost wears its own amber, brightened while it is working.
    readonly property color markTint: !Ghostd.reachable
        ? Theme.danger
        : (Ghostd.streaming ? Theme.ghostAmberBright : Theme.ghostAmber)

    Accessible.role: Accessible.Button
    Accessible.name: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
    Accessible.description: root.status

    implicitWidth: row.implicitWidth
    implicitHeight: Math.max(row.implicitHeight, 18)

    Row {
        id: row
        anchors.centerIn: parent
        spacing: 6

        Item {
            anchors.verticalCenter: parent.verticalCenter
            width: 16
            height: 16
            // The orb's bloom reaches past the glyph's box on purpose.
            clip: false

            // Behind the mascot, and only while a turn runs: the same orb the
            // HUD shows, seeded per ghost and per turn so two ghosts do not
            // shimmer alike.
            SpectralOrb {
                visible: Ghostd.streaming && Ghostd.reachable
                anchors.centerIn: parent
                diameter: 14
                running: visible
                ghost: Ghostd.activeGhost
                turnKey: Ghostd.currentSessionId + ":" + Ghostd.assistantRow
            }

            GhostGlyph {
                anchors.centerIn: parent
                size: 14
                tint: root.markTint
                // A hairline heavier than the HUD's: at 14px in a bar the
                // stroke has to survive the panel's own contrast.
                strokeWidth: 2.2

                // Offline is a state to notice, not to shout about: the mascot
                // dims rather than blinking.
                opacity: Ghostd.reachable ? 1 : 0.72
                Behavior on opacity {
                    NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
                }
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.showName
            text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
            color: root.foregroundColor
            font.family: root.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }
    }

    MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        acceptedButtons: Qt.LeftButton
        onClicked: root.toggleWindow()
    }
}
