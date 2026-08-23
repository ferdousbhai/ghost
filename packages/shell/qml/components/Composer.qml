// The input field. Enter sends, Shift+Enter opens a new line, Esc bubbles up
// to the HUD so a half-typed prompt is never a reason you can't dismiss.
//
// Plain TextEdit rather than QtQuick.Controls TextArea: Controls would pull in
// a style whose colours would compete with the shared neutral design tokens.
import QtQuick
import qs.services

Rectangle {
    id: root

    signal submitted(string text, string mode)

    property alias text: field.text

    implicitHeight: Math.min(Math.max(field.implicitHeight + Theme.pad, 48), 160)
    radius: Theme.radius
    color: Theme.surface
    border.width: 1
    border.color: field.activeFocus ? Theme.accent : Theme.border

    function take(): void {
        field.forceActiveFocus();
    }

    Flickable {
        anchors.fill: parent
        anchors.margins: Theme.pad / 2
        contentWidth: width
        contentHeight: field.implicitHeight
        clip: true
        interactive: contentHeight > height

        TextEdit {
            id: field

            width: parent.width
            focus: true
            color: Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            wrapMode: TextEdit.Wrap
            selectByMouse: true
            selectionColor: Theme.selection
            selectedTextColor: Theme.foregroundBright
            enabled: Ghostd.pendingAsk === null

            Keys.onPressed: event => {
                const enter = event.key === Qt.Key_Return || event.key === Qt.Key_Enter;
                if (enter && !(event.modifiers & Qt.ShiftModifier)) {
                    const mode = Ghostd.streaming
                        ? ((event.modifiers & Qt.ControlModifier) ? "followUp" : "steer")
                        : "prompt";
                    root.submitted(field.text, mode);
                    field.text = "";
                    event.accepted = true;
                }
            }

            Text {
                anchors.fill: parent
                visible: field.text === ""
                text: Ghostd.activeGhost === ""
                    ? "No ghost selected"
                    : (Ghostd.streaming
                        ? "Steer " + Ghostd.activeGhost + "…  ·  Ctrl+Enter follows up"
                        : "Message " + Ghostd.activeGhost + "…")
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                elide: Text.ElideRight
            }
        }
    }
}
