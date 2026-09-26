import Quickshell
import QtQuick
import "../services"

// A newer release, as the daemon last saw it. One line, the command it takes,
// and a click that copies it.
Rectangle {
    visible: Ghostd.reachable && Ghostd.updateAvailable !== null
    implicitHeight: visible ? updateLine.implicitHeight + Theme.pad * 2 : 0
    radius: Theme.bubbleRadius
    color: Theme.amber(0.08)
    border.width: 1
    border.color: Theme.amber(0.20)

    Text {
        id: updateLine
        anchors.centerIn: parent
        width: parent.width - Theme.pad * 2
        horizontalAlignment: Text.AlignHCenter
        text: Ghostd.updateAvailable
            ? "Ghost " + Ghostd.updateAvailable.latest + " is available · "
                + Ghostd.updateAvailable.command
            : ""
        color: Theme.foreground
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
        wrapMode: Text.Wrap
    }

    MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: if (Ghostd.updateAvailable)
            Quickshell.clipboardText = Ghostd.updateAvailable.command
    }
}
