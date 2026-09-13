pragma ComponentBehavior: Bound

// The persona file (character.md), edited through the daemon rather than the
// workbench's direct file editor: the daemon validates the write and owns the
// size cap, so a refused save is a visible error here instead of a broken
// cold session start later. Save is explicit — a persona is not a scratch
// buffer — and a refused save keeps the draft under the daemon's reason.
import QtQuick
import "../services"

Rectangle {
    id: root

    /** The × was clicked or Esc pressed in the editor: back to chat. */
    signal closed()

    /** The editor's draft, exposed for the save path and tests. */
    property alias draftText: editor.text
    /** The body the editor was last seeded from. While the draft still equals
        it, a fresh daemon read may replace the text harmlessly; once the
        owner has typed, the draft holds until they save or leave. */
    property string loadedBody: ""

    readonly property bool dirty: editor.text !== Ghostd.characterBody
    readonly property bool overLimit: Ghostd.characterLimit > 0
        && editor.text.length > Ghostd.characterLimit
    readonly property bool canSave: Ghostd.activeGhost !== "" && root.dirty
        && !Ghostd.characterSaving

    implicitWidth: Theme.pad * 50
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function seed(): void {
        root.loadedBody = Ghostd.characterBody;
        editor.text = Ghostd.characterBody;
    }

    function save(): void {
        if (!root.canSave) return;
        Ghostd.writeCharacter(editor.text);
    }

    Component.onCompleted: root.seed()
    // A ghost switch clears the character state without re-reading it; a
    // visible pane fetches for itself, the way McpBrowser and CommandsBrowser
    // do, so returning here never shows a permanently blank persona.
    onVisibleChanged: if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchCharacter(false)

    Connections {
        target: Ghostd

        // A fresh read only replaces text the owner has not touched; an
        // in-progress draft is never rebuilt under the caret.
        function onCharacterBodyChanged(): void {
            if (editor.text === root.loadedBody) root.seed();
        }

        // A persona typed at one ghost has no meaning in another's file.
        function onActiveGhostChanged(): void {
            root.seed();
            if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchCharacter(false);
        }

        // A save the daemon accepted makes the draft the seeded text, so the
        // re-seed guard keeps adopting later daemon reads.
        function onCharacterWriteFinished(ok: bool): void {
            // Latch the body the daemon accepted, not the draft at completion
            // time — the owner may have typed while the PUT was in flight.
            if (ok) root.loadedBody = Ghostd.characterBody;
        }
    }

    Rectangle {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: Theme.controlHeight + Theme.gap
        color: Theme.surface

        Row {
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.gap

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "Character"
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSubtitle
                font.weight: Font.DemiBold
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Ghostd.activeGhost === "" ? "" : "· " + Ghostd.activeGhost
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                visible: Ghostd.characterSaving || Ghostd.characterLoading
                text: Ghostd.characterSaving ? "Saving…" : "Reading…"
                color: Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
        }

        Row {
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.gap

            // The count against the daemon's own cap, shown once the daemon
            // has said what it is. Turning rose is the only warning; the
            // daemon stays the authority on whether the save is refused.
            Text {
                anchors.verticalCenter: parent.verticalCenter
                visible: Ghostd.characterLimit > 0
                text: editor.text.length + " / " + Ghostd.characterLimit
                color: root.overLimit ? Theme.ghostRose : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            ActionButton {
                anchors.verticalCenter: parent.verticalCenter
                label: Ghostd.characterSaving ? "Saving" : "Save"
                primary: true
                enabled: root.canSave
                opacity: enabled ? 1 : 0.5
                onClicked: root.save()
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "×"
                color: closeArea.containsMouse ? Theme.foreground : Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize

                MouseArea {
                    id: closeArea
                    anchors.fill: parent
                    anchors.margins: -Theme.gap / 2
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.closed()
                }
            }
        }

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: Theme.border
        }
    }

    Rectangle {
        id: errorBanner
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        visible: Ghostd.characterError !== ""
        height: visible ? errorText.implicitHeight + Theme.gap * 2 : 0
        color: Theme.rose(0.08)

        Text {
            id: errorText
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            text: Ghostd.characterError
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }
    }

    Flickable {
        id: scroll
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: errorBanner.bottom
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: editor.implicitHeight + Theme.pad * 2
        clip: true
        interactive: contentHeight > height
        boundsBehavior: Flickable.StopAtBounds

        TextEdit {
            id: editor
            x: Theme.pad
            y: Theme.pad
            width: scroll.width - Theme.pad * 2
            textFormat: TextEdit.PlainText
            wrapMode: TextEdit.Wrap
            color: Theme.foregroundBright
            selectionColor: Theme.selection
            selectedTextColor: Theme.foregroundBright
            font.family: Theme.fontFamilyMono
            font.pixelSize: Theme.fontSize
            activeFocusOnTab: true
            Accessible.name: "Character editor"

            Keys.onEscapePressed: event => {
                event.accepted = true;
                root.closed();
            }
        }

        MouseArea {
            anchors.fill: parent
            acceptedButtons: Qt.LeftButton
            // Clicking the empty space below a short file still lands the
            // caret in the editor, the way any full-pane editor behaves.
            onClicked: {
                editor.forceActiveFocus();
                editor.cursorPosition = editor.length;
            }
            z: -1
        }
    }
}
