// One line between the transcript and the composer that says what the ghost
// is doing right now: waiting, thinking, or inside a named tool. It replaces
// itself with the last error when a turn fails, and is invisible when idle.
import QtQuick
import qs.services

Item {
    id: root

    readonly property bool failing: !Ghostd.streaming && Ghostd.lastError !== ""
    readonly property string label: root.failing
        ? Ghostd.lastError
        : (Ghostd.activity !== "" ? Ghostd.activity : "thinking")

    implicitHeight: visible ? 18 : 0
    visible: Ghostd.streaming || root.failing

    Row {
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.gap

        Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            width: 6
            height: 6
            radius: 3
            color: root.failing ? Theme.danger : Theme.accent

            SequentialAnimation on opacity {
                running: Ghostd.streaming
                loops: Animation.Infinite
                NumberAnimation { to: 0.25; duration: 700; easing.type: Easing.InOutQuad }
                NumberAnimation { to: 1.0; duration: 700; easing.type: Easing.InOutQuad }
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: root.label
            color: root.failing ? Theme.danger : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            elide: Text.ElideRight
            width: Math.max(root.width - 6 - Theme.gap, 0)
        }
    }
}
