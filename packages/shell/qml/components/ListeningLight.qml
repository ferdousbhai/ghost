import QtQuick
import "../services"

// The listening light: amber, breathing, while Voxtype records; a click
// toggles it. Hidden where Voxtype is not installed. `input` is where the
// transcript lands, so a click gives it the keyboard first.
Rectangle {
    id: root

    property Item input: null

    visible: Dictation.available
    width: Theme.controlHeight
    height: width
    radius: width / 2
    color: Dictation.recording ? Theme.ghostAmber : Theme.film(0.10)
    Accessible.role: Accessible.Button
    Accessible.name: Dictation.recording ? "Stop listening" : "Listen"

    SequentialAnimation on opacity {
        running: Dictation.recording && !Theme.reducedMotion
        loops: Animation.Infinite
        onRunningChanged: if (!running) root.opacity = 1
        NumberAnimation { to: 0.55; duration: 700; easing.type: Easing.InOutSine }
        NumberAnimation { to: 1; duration: 700; easing.type: Easing.InOutSine }
    }

    GhostGlyph {
        anchors.centerIn: parent
        size: Theme.fontSize + 2
        path: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"
        tint: Dictation.recording ? Theme.background : Theme.foregroundBright
    }

    MouseArea {
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        onClicked: {
            if (root.input) root.input.forceActiveFocus();
            Dictation.toggle();
        }
    }
}
