// NextWorkLine — the countdown to the turn ghostd starts after an idle
// handoff ("What should we work on next?"), with the owner's way out. Writing
// a message cancels it too.
import QtQuick
import QtQuick.Layouts
import "../services"

RowLayout {
    id: root

    property int secondsLeft: 0

    function tick(): void {
        root.secondsLeft = Math.max(0, Math.ceil((Date.parse(Ghostd.continuesAt) - Date.now()) / 1000));
    }

    visible: Ghostd.continuesAt !== ""
    spacing: Theme.gap

    Timer {
        interval: 250
        repeat: true
        running: root.visible
        triggeredOnStart: true
        onTriggered: root.tick()
    }

    Text {
        Layout.fillWidth: true
        text: root.secondsLeft > 0
            ? "Asking “What should we work on next?” in " + root.secondsLeft + "s"
            : "Asking “What should we work on next?”…"
        color: Theme.foregroundDim
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
        elide: Text.ElideRight
    }

    ActionButton {
        label: "Cancel"
        onClicked: Ghostd.cancelNextWork()
    }
}
