// Compact pane actions share the desktop accent and show keyboard focus.
import QtQuick
import "../services"

Rectangle {
    id: button

    property string label: "Action"
    property bool primary: false
    property bool danger: false
    signal clicked()

    implicitWidth: buttonLabel.implicitWidth + Theme.controlPaddingX * 2
    implicitHeight: Theme.controlHeight
    radius: Theme.controlRadius
    color: button.primary
        ? Qt.alpha(Theme.accent, buttonArea.containsMouse ? 0.20 : 0.12)
        : (buttonArea.containsMouse ? Qt.alpha(Theme.foreground, 0.07) : "transparent")
    border.width: button.activeFocus || button.primary || button.danger ? 1 : 0
    border.color: button.activeFocus ? Theme.accent
        : button.danger ? Qt.alpha(Theme.danger, 0.35) : Qt.alpha(Theme.accent, 0.35)
    opacity: button.enabled ? 1 : 0.45
    activeFocusOnTab: true

    Accessible.role: Accessible.Button
    Accessible.name: button.label

    Text {
        id: buttonLabel
        anchors.centerIn: parent
        text: button.label
        color: !button.enabled ? Theme.foregroundFaint
            : (button.danger ? Theme.danger
                : (button.primary ? Theme.accent : Theme.foreground))
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
        font.weight: Font.Medium
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
