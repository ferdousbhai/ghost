// GhostBarWidget — status dot + active ghost name, sized for a bar.
//
// This is the in-process version: it reads the same Ghostd/Theme singletons the
// HUD does, so the dot lights up the instant a turn starts with no polling.
// It is used by GhostBarSurface.qml (our own always-visible layer strip).
//
// To put a ghost indicator in *Omarchy's* bar instead, the widget has to live
// inside the omarchy-shell process, which cannot see these singletons — see
// contrib/omarchy/ for the self-contained copy and the trade-off writeup.
import QtQuick
import qs.services
import qs.components

Item {
    id: root

    property color foregroundColor: Theme.barForeground
    property color idleColor: Theme.foregroundDim
    property bool showName: true

    signal activated()

    readonly property string status: !Ghostd.reachable
        ? "offline"
        : (Ghostd.streaming ? (Ghostd.activity !== "" ? Ghostd.activity : "thinking") : "idle")

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
            width: 14
            height: 14
            clip: false

            SpectralOrb {
                visible: Ghostd.streaming && Ghostd.reachable
                anchors.centerIn: parent
                diameter: 12
                running: visible
                ghost: Ghostd.activeGhost
                turnKey: Ghostd.currentSessionId + ":" + Ghostd.assistantRow
            }

            Rectangle {
                visible: !Ghostd.streaming || !Ghostd.reachable
                anchors.centerIn: parent
                width: 8
                height: 8
                radius: 4
                color: !Ghostd.reachable ? Theme.danger : root.idleColor
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: root.showName
            text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
            color: root.foregroundColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }
    }

    MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        acceptedButtons: Qt.LeftButton
        onClicked: root.activated()
    }
}
