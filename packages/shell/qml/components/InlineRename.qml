// InlineRename — a name edited where it is read, in a sidebar row.
//
// The rule it follows is the file manager's, because that is where the gesture
// comes from: Enter keeps what you typed, Esc throws it away, and clicking
// somewhere else keeps it too. Losing the keyboard is not "never mind" — the
// name you typed is the name you meant, and a rename that silently reverts
// because you looked away is worse than one that has to be undone.
//
// Plain TextInput rather than a Controls TextField, for the reason Composer.qml
// spells out: Controls drags a whole style stack into a shell that themes
// itself from Omarchy.
//
// Two things live on the LIST rather than here, and have to: the draft text and
// the latch saying which row is being renamed. A background re-list rebuilds
// every delegate, so this field is destroyed and recreated mid-edit, and
// anything it held alone would go with it. That is also why losing focus is
// reported rather than acted on — only the list can tell a rebuild apart from
// the owner clicking away.
import QtQuick
import "../services"

TextInput {
    id: field

    required property string placeholder

    signal committed()
    signal cancelled()
    signal edited(string value)
    signal focusGained()
    signal focusLost()

    function begin(draft: string): void {
        field.text = draft;
        field.forceActiveFocus();
        field.selectAll();
    }

    color: Theme.foregroundBright
    font.family: Theme.fontFamily
    font.pixelSize: Theme.fontSize
    selectByMouse: true
    selectionColor: Theme.selection
    selectedTextColor: Theme.foregroundBright
    clip: true

    onTextChanged: field.edited(field.text)
    onAccepted: field.committed()

    Keys.onEscapePressed: event => {
        event.accepted = true;
        field.cancelled();
    }

    onActiveFocusChanged: {
        if (field.activeFocus) field.focusGained();
        else field.focusLost();
    }

    Text {
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        visible: field.text === ""
        text: field.placeholder
        color: Theme.foregroundDim
        font: field.font
    }
}
