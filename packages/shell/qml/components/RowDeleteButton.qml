// RowDeleteButton — the × at the end of a roster or conversation row, turned
// to … while its delete is in flight. It only raises the request; the HUD's
// modal asks the question.
import QtQuick
import "../services"

Rectangle {
    id: button

    property bool deleting: false
    property alias containsMouse: area.containsMouse
    signal clicked()

    // Reserve the width whether or not the glyph is painted, so the text
    // beside it does not shift on hover.
    width: 16
    height: Theme.controlHeight
    radius: Theme.radius / 2
    color: area.containsMouse || button.deleting ? Theme.rose(0.10) : "transparent"

    Behavior on color {
        enabled: !Theme.reducedMotion
        ColorAnimation { duration: Theme.durFast }
    }

    Text {
        anchors.centerIn: parent
        text: button.deleting ? "…" : "×"
        color: area.containsMouse || button.deleting ? Theme.ghostRose : Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
    }

    MouseArea {
        id: area
        anchors.fill: parent
        enabled: !button.deleting
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: button.clicked()
    }
}
