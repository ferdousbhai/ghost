pragma ComponentBehavior: Bound

// The ghost roster: who exists, who the HUD is talking to, and a way to
// summon a new one. Names come from GET /api/ghosts; creating posts back.
import QtQuick
import qs.services

Item {
    id: root

    /** Emitted after a ghost is picked, so the HUD can return focus to the composer. */
    signal picked()

    property bool naming: false

    implicitWidth: 190
    implicitHeight: column.implicitHeight

    Column {
        id: column
        width: root.width
        spacing: Theme.gap

        Text {
            text: "Ghosts"
            color: Theme.foreground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.weight: Font.DemiBold
        }

        Repeater {
            model: Ghostd.ghosts

            Rectangle {
                id: entry

                required property var modelData

                width: root.width
                height: Theme.controlHeight
                radius: Theme.radius / 2
                color: entry.modelData.name === Ghostd.activeGhost
                    ? Theme.selection
                    : (entryArea.containsMouse ? Theme.hover : "transparent")

                Row {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.gap
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.gap
                    spacing: Theme.gap

                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 2
                        height: 18
                        radius: 1
                        visible: entry.modelData.name === Ghostd.activeGhost
                        color: Theme.accent
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width - 2 - Theme.gap
                        text: entry.modelData.name
                        color: entry.modelData.name === Ghostd.activeGhost
                            ? Theme.foregroundBright
                            : Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        elide: Text.ElideRight
                    }
                }

                MouseArea {
                    id: entryArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        Ghostd.selectGhost(entry.modelData.name);
                        root.picked();
                    }
                }
            }
        }

        Text {
            visible: Ghostd.ghosts.length === 0
            width: root.width
            text: Ghostd.reachable ? "No ghosts yet" : "ghostd unreachable"
            color: Ghostd.reachable ? Theme.foregroundDim : Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        // ---- New ghost ----------------------------------------------------

        Rectangle {
            width: root.width
            height: Theme.controlHeight
            radius: Theme.radius / 2
            color: root.naming ? Theme.surfaceDeep
                : (newGhostArea.containsMouse ? Theme.hover : "transparent")
            border.width: root.naming ? 1 : 0
            border.color: root.naming ? Theme.accent : Theme.border

            Text {
                visible: !root.naming
                anchors.left: parent.left
                anchors.leftMargin: Theme.gap
                anchors.verticalCenter: parent.verticalCenter
                text: "+ New ghost"
                color: Theme.foreground
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            TextInput {
                id: nameField
                visible: root.naming
                anchors.fill: parent
                anchors.margins: Theme.gap
                verticalAlignment: TextInput.AlignVCenter
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                selectByMouse: true
                selectionColor: Theme.selection
                onAccepted: {
                    Ghostd.createGhost(text);
                    text = "";
                    root.naming = false;
                    root.picked();
                }
                Keys.onEscapePressed: {
                    nameField.text = "";
                    root.naming = false;
                    root.picked();
                }
            }

            MouseArea {
                id: newGhostArea
                anchors.fill: parent
                visible: !root.naming
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    root.naming = true;
                    nameField.forceActiveFocus();
                }
            }
        }
    }
}
