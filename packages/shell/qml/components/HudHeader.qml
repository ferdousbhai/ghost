import QtQuick
import "../services"

// The HUD's top line: who is present, which model answers, and how to stop a
// running turn.
Item {
    id: root

    /** The model indicator was clicked. */
    signal modelsRequested()

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

        // Current-model indicator: the model's provider/id, a "Default" hint
        // when the pick is only a fallback, "Default" when pi picks unseen,
        // and a call to action when nothing can answer.
        Rectangle {
            id: modelIndicator

            readonly property bool noneSet: Ghostd.noModel

            anchors.verticalCenter: parent.verticalCenter
            visible: Ghostd.activeGhost !== ""
            implicitWidth: indicatorRow.implicitWidth + Theme.pad * 1.5
            implicitHeight: 28
            radius: Theme.radius / 2
            color: indicatorArea.containsMouse ? Theme.hover : "transparent"
            border.width: modelIndicator.noneSet ? 1 : 0
            border.color: modelIndicator.noneSet ? Theme.warn : Theme.border

            Row {
                id: indicatorRow
                anchors.centerIn: parent
                spacing: Theme.gap / 2

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: Ghostd.currentModel
                        ? (Ghostd.currentModel.provider + "/" + Ghostd.currentModel.id)
                        // A GUI button is a worse place for a CLI incantation
                        // than the CLI is: the click itself is the instruction.
                        : Ghostd.noModel ? "Connect a provider" : "Default"
                    color: modelIndicator.noneSet ? Theme.warn : Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    elide: Text.ElideRight
                }

                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    visible: Ghostd.currentModel && Ghostd.modelSource === "none"
                    text: "· Default"
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }
            }

            MouseArea {
                id: indicatorArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.modelsRequested()
            }
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
