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

    Column {
        anchors.fill: parent
        spacing: Theme.gap

        Text {
            text: "GHOSTS"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.letterSpacing: 1.5
        }

        Repeater {
            model: Ghostd.ghosts

            Rectangle {
                id: entry

                required property var modelData

                width: root.width
                height: 30
                radius: Theme.radius / 2
                color: entry.modelData.name === Ghostd.activeGhost ? Theme.selection : "transparent"

                Row {
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.gap
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.gap
                    spacing: Theme.gap

                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 6
                        height: 6
                        radius: 3
                        color: entry.modelData.name === Ghostd.activeGhost && Ghostd.streaming
                            ? Theme.accent
                            : Theme.muted
                    }

                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width - 6 - Theme.gap
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
                    anchors.fill: parent
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
            text: Ghostd.reachable ? "no ghosts yet" : "ghostd unreachable"
            color: Ghostd.reachable ? Theme.foregroundDim : Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        // ---- New ghost ----------------------------------------------------

        Rectangle {
            width: root.width
            height: 30
            radius: Theme.radius / 2
            color: root.naming ? Theme.surfaceDeep : "transparent"
            border.width: 1
            border.color: root.naming ? Theme.accent : Theme.muted

            Text {
                visible: !root.naming
                anchors.centerIn: parent
                text: "+ new ghost"
                color: Theme.foregroundDim
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
                anchors.fill: parent
                visible: !root.naming
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    root.naming = true;
                    nameField.forceActiveFocus();
                }
            }
        }
    }
}
