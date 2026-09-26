// SearchField — the one-line filter above a long pane list. `text` is what the
// owner typed; Up/Down/Return are re-emitted so the list, not the field, owns
// its selection. Escape is left to propagate, so the pane or the HUD answers it.
import QtQuick
import "../services"

Rectangle {
    id: field

    property alias text: input.text
    property string placeholder: "Search"
    signal moved(int step)
    signal accepted()

    function focusInput(): void { input.forceActiveFocus(); }

    implicitHeight: Theme.controlHeight
    radius: Theme.radius
    color: Theme.film(0.05)
    border.width: input.activeFocus ? 1 : 0
    border.color: Theme.amber(0.50)

    TextInput {
        id: input
        anchors.fill: parent
        anchors.leftMargin: Theme.pad
        anchors.rightMargin: Theme.pad
        verticalAlignment: TextInput.AlignVCenter
        color: Theme.foregroundBright
        selectionColor: Theme.selection
        selectedTextColor: Theme.foregroundBright
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
        clip: true
        activeFocusOnTab: true
        Accessible.name: field.placeholder

        Keys.onUpPressed: field.moved(-1)
        Keys.onDownPressed: field.moved(1)
        Keys.onReturnPressed: field.accepted()
        Keys.onEnterPressed: field.accepted()

        Text {
            anchors.fill: parent
            verticalAlignment: Text.AlignVCenter
            visible: input.text === ""
            text: field.placeholder
            color: Theme.foregroundFaint
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            elide: Text.ElideRight
        }
    }
}
