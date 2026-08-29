// ActionButton — the pane button: a label on a film, brighter when primary,
// rose-bordered when it destroys something. Enter/Space and a click are the
// same gesture.
import QtQuick
import qs.services

Rectangle {
    id: button

    property string label: "Action"
    property bool primary: false
    property bool danger: false
    signal clicked()

    implicitWidth: buttonLabel.implicitWidth + Theme.pad * 1.5
    implicitHeight: Theme.controlHeight
    radius: Theme.radius
    color: button.primary
        ? (buttonArea.containsMouse ? Theme.amber(0.20) : Theme.amber(0.13))
        : (buttonArea.containsMouse ? Theme.film(0.09) : Theme.film(0.05))
    border.width: button.primary || button.danger ? 1 : 0
    border.color: button.danger ? Theme.rose(0.30) : Theme.amber(0.28)
    activeFocusOnTab: true

    Accessible.role: Accessible.Button
    Accessible.name: button.label

    Text {
        id: buttonLabel
        anchors.centerIn: parent
        text: button.label
        color: !button.enabled ? Theme.foregroundFaint
            : (button.danger ? Theme.danger
                : (button.primary ? Theme.ghostAmberBright : Theme.foreground))
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
        font.weight: button.primary ? Font.DemiBold : Font.Normal
    }

    MouseArea {
        id: buttonArea
        anchors.fill: parent
        enabled: button.enabled
        hoverEnabled: true
        cursorShape: Qt.PointingHandCursor
        onClicked: button.clicked()
    }

    Keys.onPressed: event => {
        if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                || event.key === Qt.Key_Space) && button.enabled) {
            button.clicked();
            event.accepted = true;
        }
    }
}
