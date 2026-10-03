import QtQuick
import "../services"

// The HUD's top line: who is present, which agent CLI is answering the open
// conversation, and how to stop a running turn.
Item {
    id: root

    implicitHeight: 32

    Row {
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.gap

        // Presence, not a status LED: the mascot itself carries reachability.
        // Amber and haloed when the daemon answers, bare danger-red when it
        // does not.
        Item {
            anchors.verticalCenter: parent.verticalCenter
            implicitWidth: 16
            implicitHeight: 16

            Glow {
                anchors.centerIn: parent
                width: 16 * 2.2
                visible: Ghostd.reachable
                core: Theme.amber(0.25)
                mid: Theme.amber(0.08)
                midAt: 0.55
            }

            GhostGlyph {
                anchors.centerIn: parent
                size: 16
                tint: Ghostd.reachable ? Theme.ghostAmber : Theme.danger
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
            color: Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSubtitle
            font.weight: Font.DemiBold
        }
    }

    Row {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.pad

        // The harness is the daemon's choice, per conversation; it is only
        // reported here, never picked.
        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: Ghostd.currentHarness !== ""
            text: "via " + Ghostd.currentHarness
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: Ghostd.streaming
            text: "Esc to stop"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }
    }
}
