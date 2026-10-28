import QtQuick
import "../services"

// A one-glyph control — ‹ back, × close — as Omarchy's menu draws them: a
// plain mark that brightens under the pointer, with a hit area a gap wider
// than the glyph.
Text {
    id: root

    /** What the control does, for a screen reader. */
    property string name
    property color restColor: Theme.foregroundFaint
    property color hoverColor: Theme.menuSelectedText

    signal clicked()

    color: area.containsMouse ? root.hoverColor : root.restColor
    font.family: Theme.fontFamily
    font.pixelSize: Theme.fontSizeTitle
    Accessible.role: Accessible.Button
    Accessible.name: root.name
    Accessible.onPressAction: root.clicked()

    MouseArea {
        id: area
        anchors.fill: parent
        anchors.margins: -Theme.gap
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: root.clicked()
    }
}
