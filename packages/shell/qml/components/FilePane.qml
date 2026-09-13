pragma ComponentBehavior: Bound

// One open file in the workbench: a slim header over a body that is a Markdown
// editor, a code reader, or plain text, chosen by extension.
//
// The pane owns the only FileView, and with it the whole save/reload policy,
// because that policy is one decision and splitting it across the two body
// components would give it two half-answers. `watchChanges` is on so the
// ghost's own edits stream into a pane the user already has open — that is the
// point of having the workbench next to the transcript.
//
// The conflict rule, stated once: when the file changes underneath a buffer the
// user has been typing into, neither side wins automatically. Adopting disk
// would throw away typing that was never anywhere else; writing the buffer
// would throw away whatever the ghost just wrote. But the two are usually
// nowhere near each other, so the pane tries a line-based three-way merge first
// (Merge.js) against the text it last read or wrote, and when that comes out
// clean it says *nothing*: the merged text is in the buffer, autosave writes it
// a moment later, and the user never learns there was a race. Only when both
// sides moved the same lines does the old behaviour apply — buffer stays on
// screen, autosave suspends, one line with the two resolutions next to it. A
// clean buffer has nothing to lose and simply follows the file.
//
// A pane is bound to one path *for the life of the binding*: if the owner
// repoints `filePath`, unsaved text is flushed to the old path before the new
// one is read, so a buffer can never be written to a file the user did not
// type it into.
import QtQuick
import Quickshell.Io
import "../services"
import "Highlighter.js" as Highlighter
import "Merge.js" as Merge

Item {
    id: root

    required property string filePath

    signal closed()

    readonly property string fileName: Highlighter.baseName(root.filePath)
    readonly property string parentDir: Highlighter.parentPath(root.filePath)
    readonly property bool markdown: Highlighter.isMarkdown(root.filePath)
    readonly property bool code: !root.markdown
        && Highlighter.languageOf(root.filePath) !== ""

    /** The file's text as we last read or wrote it. Doubles as the merge base:
        it is the last point at which the buffer and the file were the same
        text, which is exactly what a three-way merge needs. */
    property string diskText: ""
    /** Set while a write is in flight, so a failure can put the dot back. */
    property string preWriteDisk: ""
    property string conflictText: ""
    property string notice: ""

    readonly property bool dirty: root.markdown && editor.dirty

    implicitWidth: 480
    implicitHeight: 320


    function absorb(incoming: string): void {
        if (incoming === root.diskText) return;
        if (!root.markdown || !editor.dirty) {
            root.diskText = incoming;
            if (root.markdown) editor.adopt(incoming);
            root.conflictText = "";
            root.notice = "";
            return;
        }
        if (incoming === editor.buffer) {
            root.diskText = incoming;
            return;
        }
        // Merge first. `diskText` is still the common ancestor here — the
        // dirty path never advances it — so the three texts are the real
        // three-way inputs.
        const merged = Merge.merge(root.diskText, editor.buffer, incoming);
        if (merged.ok) {
            // The base moves to what is on disk *now*, which leaves the merged
            // buffer dirty against it by exactly the user's own edits, so the
            // ordinary debounced autosave carries them back to the file. adopt()
            // is deliberately silent, so the timer is ours to start.
            root.diskText = incoming;
            editor.adoptMerged(merged.text);
            root.conflictText = "";
            root.notice = "";
            autosave.restart();
            return;
        }
        root.conflictText = incoming;
        root.notice = "Changed on disk while you were editing.";
    }

    function save(): void {
        // Three reasons not to write, all of them cheap to check: nothing to
        // save, nothing changed, or a conflict we have not been told how to
        // settle.
        if (!root.markdown || !editor.dirty || root.conflictText !== "") return;
        autosave.stop();
        root.preWriteDisk = root.diskText;
        root.diskText = editor.buffer;
        file.setText(editor.buffer);
    }

    /** Save now and wait for it — for closing, hiding, and rebinding, where
        the pane may not be around when an async write would have landed. */
    function flush(): void {
        if (!root.markdown || !editor.dirty || root.conflictText !== "") return;
        root.save();
        file.waitForJob();
    }

    // Both resolutions end with buffer and file holding the same text and
    // `diskText` naming it, which is what leaves a correct base behind for the
    // *next* external change: keepMine() through save(), which sets diskText to
    // what it wrote, takeTheirs() by adopting outright.

    function keepMine(): void {
        root.conflictText = "";
        root.notice = "";
        root.save();
    }

    function takeTheirs(): void {
        const incoming = root.conflictText;
        root.conflictText = "";
        root.notice = "";
        root.diskText = incoming;
        editor.adopt(incoming);
    }

    Component.onCompleted: file.path = root.filePath
    Component.onDestruction: root.flush()

    onVisibleChanged: if (!root.visible) root.flush()

    // file.path is assigned rather than bound precisely so that it still holds
    // the *previous* path here, and the flush lands on the right file.
    onFilePathChanged: {
        root.flush();
        root.diskText = "";
        root.conflictText = "";
        root.notice = "";
        editor.adopt("");
        file.path = root.filePath;
    }

    FileView {
        id: file

        watchChanges: true
        atomicWrites: true
        printErrors: false

        onLoaded: root.absorb(file.text())
        onLoadFailed: {
            root.diskText = "";
            root.notice = "Could not read this file.";
        }
        // watchChanges reports the change; re-reading is ours to ask for.
        onFileChanged: file.reload()
        onSaved: if (root.conflictText === "") root.notice = ""
        onSaveFailed: {
            root.diskText = root.preWriteDisk;
            root.notice = "Could not save — your edits are still here.";
        }
    }

    Timer {
        id: autosave
        // Long enough to sit inside a burst of typing, short enough that
        // "unsaved" is a state you glimpse rather than one you live in.
        interval: 800
        onTriggered: root.save()
    }


    Rectangle {
        id: header

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: Theme.controlHeight + Theme.gap
        color: "transparent"

        Row {
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.right: actions.left
            anchors.rightMargin: Theme.gap
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.gap

            Text {
                text: root.fileName
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                font.weight: Font.DemiBold
                elide: Text.ElideMiddle
            }

            // Apple Notes' unsaved mark: a dot, not a word. Pending state is
            // measured in a second or two, so it reads as breathing rather
            // than as a warning.
            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: 6
                height: 6
                radius: 3
                // Opacity, not visibility: the name beside it must not shift
                // sideways every time a save lands.
                opacity: root.dirty ? 1 : 0
                color: Theme.ghostAmber

                Behavior on opacity {
                    enabled: !Theme.reducedMotion
                    NumberAnimation { duration: Theme.durFast }
                }
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: root.parentDir
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                elide: Text.ElideLeft
            }
        }

        Row {
            id: actions

            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.gap

            // For markdown this is the view switch; for anything else it just
            // names what you are looking at.
            Text {
                id: mode

                anchors.verticalCenter: parent.verticalCenter
                text: root.markdown
                    ? (editor.reading ? "reading" : "source")
                    : Highlighter.languageLabel(root.filePath)
                color: root.markdown && modeArea.containsMouse
                    ? Theme.ghostAmber : Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall

                MouseArea {
                    id: modeArea
                    anchors.fill: parent
                    anchors.margins: -Theme.gap / 2
                    enabled: root.markdown
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: editor.reading = !editor.reading
                }
            }

            // The same file in a real editor: the project folder as the
            // workspace, this file focused. A glyph rather than a word, because
            // the label beside it names a *mode* and this is an action.
            //
            // The pane is left exactly as it is — this is a second window onto
            // the file, not a handoff, and `watchChanges` keeps the two in
            // step. Unsaved text is flushed first all the same, so the editor
            // opens what the user has actually typed rather than the last
            // autosave.
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: "↗"
                color: editorArea.containsMouse ? Theme.foreground : Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize

                MouseArea {
                    id: editorArea
                    anchors.fill: parent
                    anchors.margins: -Theme.gap / 2
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        root.flush();
                        Workbench.openInEditor(root.filePath);
                    }
                }
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
                    onClicked: {
                        root.flush();
                        root.closed();
                    }
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


    Item {
        id: noticeLine

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        height: visible ? Theme.controlHeight - Theme.gap : 0
        visible: root.notice !== ""

        Row {
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.gap

            Text {
                text: root.notice
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                elide: Text.ElideRight
            }

            Text {
                visible: root.conflictText !== ""
                text: "keep mine"
                color: keepArea.containsMouse ? Theme.ghostAmberBright : Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall

                MouseArea {
                    id: keepArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.keepMine()
                }
            }

            Text {
                visible: root.conflictText !== ""
                text: "take theirs"
                color: takeArea.containsMouse ? Theme.ghostAmberBright : Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall

                MouseArea {
                    id: takeArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.takeTheirs()
                }
            }
        }
    }

    //
    // All three bodies exist for the pane's lifetime and one is shown. A
    // Loader would hand back an untyped item, and the header and the save
    // policy both need the markdown editor's `dirty` and `buffer` by name.

    Item {
        id: body

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: noticeLine.bottom
        anchors.bottom: parent.bottom
        clip: true

        MarkdownEditor {
            id: editor

            anchors.fill: parent
            visible: root.markdown
            enabled: root.markdown
            // Empty for a non-markdown file, so an idle editor can never look dirty
            // against a code file's text.
            source: root.markdown ? root.diskText : ""

            onEdited: if (root.conflictText === "") autosave.restart()
        }

        CodeView {
            anchors.fill: parent
            visible: root.code
            source: root.code ? root.diskText : ""
            filePath: root.filePath
        }

        // Everything else: a log, a licence, a file with no extension. Read
        // it, copy from it, and no more than that.
        Flickable {
            anchors.fill: parent
            visible: !root.markdown && !root.code
            clip: true
            contentWidth: width
            contentHeight: plain.implicitHeight + Theme.pad * 2
            boundsBehavior: Flickable.StopAtBounds

            TextEdit {
                id: plain

                x: Theme.pad
                y: Theme.pad
                width: parent.width - Theme.pad * 2
                readOnly: true
                selectByMouse: true
                text: (!root.markdown && !root.code) ? root.diskText : ""
                textFormat: TextEdit.PlainText
                wrapMode: TextEdit.Wrap
                color: Theme.foreground
                selectionColor: Theme.selection
                selectedTextColor: Theme.foregroundBright
                font.family: Theme.fontFamilyMono
                font.pixelSize: Theme.fontSize
            }
        }
    }
}
