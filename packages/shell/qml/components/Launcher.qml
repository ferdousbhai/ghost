pragma ComponentBehavior: Bound

// Launcher — where the HUD opens: a filter over this ghost's conversations
// and places, drawn as the desktop's own menu is (Omarchy's [menu] tokens),
// so Ghost reads as part of the machine rather than an app on it.
//
// Typing filters; Up/Down move; Enter opens the row, or asks the ghost what
// was typed when nothing matches. Tab moves to the next ghost. On a
// conversation, Ctrl+R renames it where it is read, Ctrl+P pins it, and
// Delete (with the cursor at the end of the filter) asks to trash it. Esc is
// the HUD's: it closes.
//
// The "ghosts" mode is the same card over the ghosts: Enter makes one the
// HUD's, a free valid name typed into the filter offers to summon it, Ctrl+R
// renames and Delete asks to banish. Esc, or the ‹, goes back.
import QtQuick
import "../services"
import "Launcher.js" as Launcher

FocusScope {
    id: root

    /** A row was chosen, or Ctrl+N: { kind: "new" | "ask" | "session" | "place" | "ghost" | "summon", id, title, detail }. */
    signal activated(var row)
    signal deleteRequested(string sessionId, string title)
    signal banishRequested(string name)
    signal backRequested()
    signal closeRequested()

    /** "home" (conversations and places) or "ghosts". */
    property string mode: "home"
    readonly property bool ghostMode: root.mode === "ghosts"

    property real maxListHeight: 480
    property real now: Date.now()

    readonly property var rows: root.ghostMode
        ? Launcher.ghostRows(filter.text, Ghostd.ghosts, Ghostd.activeGhost)
        : Launcher.rows(filter.text, Ghostd.sessions, Ghostd.activeGhost, root.now, Ghostd.activeHookCount)
    property int selected: Launcher.first(root.rows)
    readonly property var current: root.selected >= 0 && root.selected < root.rows.length
        ? root.rows[root.selected] : null

    // Held here, not on the row: a re-list rebuilds every delegate, under a
    // half-typed name.
    readonly property RenameSession rename: RenameSession {
        commit: (id, draft) => Ghostd.renameConversation(id, draft)
        onFinished: filter.forceActiveFocus()
    }
    readonly property RenameSession ghostRename: RenameSession {
        commit: (from, draft) => Ghostd.renameGhost(from, draft)
        onFinished: filter.forceActiveFocus()
    }

    /** The rename a row's name goes through, or null for rows without one. */
    function renameFor(row: var): var {
        return row.kind === "session" ? root.rename : row.kind === "ghost" ? root.ghostRename : null;
    }

    readonly property int rowHeight: Theme.controlHeight + Theme.gap * 2
    // Where a row's text starts, inside the list: its mark's slot, then a gap.
    // Section labels start there too, so a heading lines up with what it heads.
    readonly property real markInset: Theme.pad - Theme.gap
    readonly property real markWidth: Theme.fontSize + 6
    readonly property real textInset: root.markInset + root.markWidth + Theme.gap * 1.5
    readonly property int headerRowHeight: Theme.fontSizeCaption + Theme.gap * 3

    implicitHeight: header.height + 1 + list.height + footer.height + Theme.gap * 2

    onRowsChanged: root.selected = Launcher.first(root.rows)
    onModeChanged: root.reset()

    /** Fresh on every open: an empty filter, the newest conversations, the keyboard here. */
    function reset(): void {
        root.askAfterDictation = false;
        filter.text = "";
        Ghostd.ghostRenameError = "";
        root.now = Date.now();
        root.selected = Launcher.first(root.rows);
        list.positionViewAtBeginning();
        filter.forceActiveFocus();
    }

    /** The HUD closed: an Enter-while-listening ask still waiting is not sent. */
    function abandonAsk(): void {
        root.askAfterDictation = false;
        askTimer.stop();
    }

    function move(direction: int): void {
        // Choosing a row by hand is not speaking: stop listening, so Enter opens it.
        if (Dictation.cancellable && !root.askAfterDictation) Dictation.cancel();
        root.selected = Launcher.step(root.rows, root.selected, direction);
        list.positionViewAtIndex(root.selected, ListView.Contain);
    }

    /** Enter stopped the recording: ask with the transcript once it has stopped arriving. */
    property bool askAfterDictation: false

    function dictationSettled(): void {
        root.askAfterDictation = false;
        const text = filter.text.trim();
        if (text !== "" && Ghostd.activeGhost !== "") root.activated({ kind: "ask", id: "ask", detail: text });
    }

    // Voxtype types a transcript a few characters at a time; ask once it has
    // gone quiet after the recording stopped.
    Timer {
        id: askTimer
        interval: 700
        onTriggered: root.dictationSettled()
    }
    Connections {
        target: Dictation
        function onStateChanged(): void {
            if (root.askAfterDictation && Dictation.state === "idle") askTimer.restart();
        }
    }
    Connections {
        target: filter
        function onTextChanged(): void {
            if (root.askAfterDictation) askTimer.restart();
        }
    }

    function activate(row: var): void {
        if (row && row.kind !== "header") root.activated(row);
    }

    // The desktop's menu refreshes ages each time it opens; so does this.
    Timer {
        interval: 60000
        repeat: true
        running: root.visible
        onTriggered: root.now = Date.now()
    }

    Item {
        id: header
        width: parent.width
        height: Theme.controlHeight + Theme.pad * 1.2

        // The way back from the ghosts to the conversations.
        GlyphButton {
            id: back
            visible: root.ghostMode
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            text: "‹"
            name: "Back to the list"
            restColor: Theme.foregroundDim
            font.pixelSize: Theme.fontSizeHeading
            onClicked: root.backRequested()
        }

        TextInput {
            id: filter
            objectName: "launcherFilter"
            anchors.left: back.visible ? back.right : parent.left
            anchors.leftMargin: back.visible ? Theme.gap * 1.5 : Theme.pad
            anchors.right: mic.visible ? mic.left : ghostChip.visible ? ghostChip.left : closeMark.left
            anchors.rightMargin: Theme.gap
            anchors.verticalCenter: parent.verticalCenter
            focus: true
            clip: true
            color: Theme.menuText
            selectionColor: Theme.menuSelectedBackground
            selectedTextColor: Theme.menuSelectedText
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeTitle

            Text {
                anchors.fill: parent
                visible: filter.text === ""
                verticalAlignment: Text.AlignVCenter
                text: root.ghostMode ? "Find a ghost, or name a new one…"
                    : root.askAfterDictation ? "Transcribing…"
                    : Dictation.recording ? "Listening… or type"
                    : Ghostd.activeGhost === "" ? "Search" : "Search, or ask " + Ghostd.activeGhost + "…"
                color: !root.ghostMode && Dictation.recording ? Theme.ghostAmber : Theme.foregroundFaint
                font: filter.font
            }

            Keys.onPressed: event => {
                const ctrl = (event.modifiers & Qt.ControlModifier) !== 0;
                if (event.key === Qt.Key_Down || (ctrl && event.key === Qt.Key_J)) root.move(1);
                else if (event.key === Qt.Key_Up || (ctrl && event.key === Qt.Key_K)) root.move(-1);
                else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && Dictation.recording && !root.ghostMode) {
                    // Enter while listening is "that's it": stop, and ask
                    // the ghost what was said once Voxtype has typed it.
                    root.askAfterDictation = true;
                    Dictation.toggle();
                } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) root.activate(root.current);
                else if (event.key === Qt.Key_Tab && !root.ghostMode) Ghostd.selectNextGhost();
                else if (ctrl && event.key === Qt.Key_N && !root.ghostMode) root.activated({ kind: "new", id: "new" });
                else if (ctrl && event.key === Qt.Key_P && root.current && root.current.kind === "session")
                    Ghostd.pinConversation(root.current.id, !root.current.pinned);
                else if (ctrl && event.key === Qt.Key_R && root.current && root.renameFor(root.current))
                    root.renameFor(root.current).begin(root.current.id, root.current.title);
                else if (event.key === Qt.Key_Delete && filter.cursorPosition === filter.text.length
                        && root.current && root.current.kind === "session")
                    root.deleteRequested(root.current.id, root.current.label);
                else if (event.key === Qt.Key_Delete && filter.cursorPosition === filter.text.length
                        && root.current && root.current.kind === "ghost")
                    root.banishRequested(root.current.id);
                else return;
                event.accepted = true;
            }
        }

        ListeningLight {
            id: mic
            visible: Dictation.available && !root.ghostMode
            anchors.right: ghostChip.left
            anchors.rightMargin: Theme.gap * 2
            anchors.verticalCenter: parent.verticalCenter
            width: Theme.controlHeight * 0.8
            input: filter
        }

        // Whose launcher this is; Tab or a click moves to the next ghost.
        Text {
            id: ghostChip
            objectName: "ghostChip"
            visible: !root.ghostMode
            anchors.right: closeMark.left
            anchors.rightMargin: Theme.gap * 2
            anchors.verticalCenter: parent.verticalCenter
            text: Ghostd.activeGhost + (Ghostd.ghosts.length > 1 ? "  ⇥" : "")
            color: chipArea.containsMouse ? Theme.menuSelectedText : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize

            MouseArea {
                id: chipArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: Ghostd.selectNextGhost()
            }
        }

        // The way out, in sight: Esc does the same, and SUPER+W closes the window.
        // Inside the header, so the chip and filter can anchor to it.
        GlyphButton {
            id: closeMark
            objectName: "launcherClose"
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            text: "×"
            name: "Close Ghost"
            onClicked: root.closeRequested()
        }
    }

    Rectangle {
        id: rule
        anchors.top: header.bottom
        width: parent.width
        height: 1
        color: Theme.film(0.08)
    }

    ListView {
        id: list
        anchors.top: rule.bottom
        anchors.topMargin: Theme.gap
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.leftMargin: Theme.gap
        anchors.rightMargin: Theme.gap
        height: Math.min(root.maxListHeight, list.contentHeight)
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        model: root.rows
        currentIndex: root.selected
        highlightMoveDuration: 0

        delegate: Item {
            id: row

            required property var modelData
            required property int index
            readonly property bool header: row.modelData.kind === "header"
            readonly property bool chosen: row.index === root.selected
            readonly property var renaming: root.renameFor(row.modelData)
            readonly property bool editing: row.renaming !== null && row.renaming.editingKey === row.modelData.id

            onEditingChanged: if (row.editing) renameField.begin(row.renaming.draft)
            Component.onCompleted: if (row.editing) renameField.begin(row.renaming.draft)

            width: list.width
            height: row.header ? root.headerRowHeight : root.rowHeight

            Text {
                visible: row.header
                anchors.left: parent.left
                anchors.leftMargin: root.textInset
                anchors.bottom: parent.bottom
                anchors.bottomMargin: Theme.gap / 2
                text: row.modelData.label.toUpperCase()
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
                font.letterSpacing: 1.2
            }

            Rectangle {
                visible: !row.header
                anchors.fill: parent
                radius: Theme.controlRadius
                color: row.chosen ? Theme.menuSelectedBackground : "transparent"
                border.width: row.chosen ? 1 : 0
                border.color: Theme.menuSelectedBorder

                // The chosen row is lit from its leading edge, as a game menu
                // lights its cursor: a short accent bar and a wash that fades
                // out before the title ends.
                Rectangle {
                    visible: row.chosen
                    anchors.fill: parent
                    radius: parent.radius
                    gradient: Gradient {
                        orientation: Gradient.Horizontal
                        GradientStop { position: 0.0; color: Qt.rgba(Theme.menuSelectedText.r, Theme.menuSelectedText.g, Theme.menuSelectedText.b, 0.10) }
                        GradientStop { position: 0.45; color: Qt.rgba(Theme.menuSelectedText.r, Theme.menuSelectedText.g, Theme.menuSelectedText.b, 0) }
                    }
                }
                Rectangle {
                    visible: row.chosen
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: 2
                    height: parent.height * 0.5
                    radius: 1
                    color: Theme.menuSelectedText
                    opacity: 0.8
                }

                // The mark: a place's glyph, a running turn's orb, an unread
                // dot, a pin, or the ghost's own mark for asking it.
                Item {
                    id: mark
                    anchors.left: parent.left
                    anchors.leftMargin: root.markInset
                    anchors.verticalCenter: parent.verticalCenter
                    width: root.markWidth
                    height: width

                    GhostGlyph {
                        anchors.centerIn: parent
                        visible: row.modelData.kind !== "session"
                        size: Theme.fontSize + 2
                        path: row.modelData.kind === "place" ? row.modelData.icon
                            : row.modelData.kind === "summon" ? "M12 5v14M5 12h14"
                            : "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8zM9 10h.01M15 10h.01"
                        // The current ghost keeps its own amber, as in the bar.
                        tint: row.modelData.kind === "ghost" && row.modelData.id === Ghostd.activeGhost
                            ? Theme.ghostAmber
                            : row.chosen ? Theme.menuSelectedText : Theme.foregroundDim
                    }

                    SpectralOrb {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "session" && row.modelData.running === true
                        diameter: Theme.fontSize
                        turnKey: row.modelData.id
                    }

                    // Waiting on the owner: herdr's blocked red, above all else but a running turn.
                    Rectangle {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "session" && row.modelData.running !== true
                            && row.modelData.asking === true
                        width: 7
                        height: 7
                        radius: 3.5
                        color: Theme.danger
                    }

                    Rectangle {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "session" && row.modelData.running !== true
                            && row.modelData.asking !== true && row.modelData.unread === true
                        width: 6
                        height: 6
                        radius: 3
                        // herdr's "done": finished, not yet seen; the bar's blue.
                        color: Theme.info
                    }

                    Text {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "session" && row.modelData.running !== true
                            && row.modelData.asking !== true && row.modelData.unread !== true
                            && row.modelData.pinned === true
                        text: "★"
                        color: Theme.foregroundFaint
                        font.pixelSize: Theme.fontSizeCaption
                    }
                }

                InlineRename {
                    id: renameField
                    visible: row.editing
                    anchors.left: mark.right
                    anchors.leftMargin: Theme.gap * 1.5
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad
                    anchors.verticalCenter: parent.verticalCenter
                    placeholder: row.modelData.kind === "ghost" ? "Rename this ghost" : "Name this conversation"
                    session: row.renaming
                    live: row.editing
                }

                Text {
                    id: label
                    visible: !row.editing
                    anchors.left: mark.right
                    anchors.leftMargin: Theme.gap * 1.5
                    anchors.verticalCenter: parent.verticalCenter
                    width: Math.min(implicitWidth, parent.width - mark.width - meta.width - Theme.pad * 3)
                    elide: Text.ElideRight
                    text: row.modelData.label
                    color: row.chosen ? Theme.menuSelectedText : Theme.menuText
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                }

                Text {
                    visible: !row.editing
                    anchors.left: label.right
                    anchors.leftMargin: Theme.gap * 1.5
                    anchors.right: meta.left
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    elide: Text.ElideRight
                    text: row.modelData.detail || ""
                    color: Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                }

                Text {
                    id: meta
                    anchors.right: trash.visible ? trash.left : parent.right
                    anchors.rightMargin: trash.visible ? Theme.gap * 1.5 : Theme.pad - Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    text: row.modelData.meta || ""
                    color: Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                }

                MouseArea {
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onEntered: root.selected = row.index
                    onClicked: root.activate(row.modelData)
                }

                // On the row under the pointer or keyboard: move it to Trash,
                // asked first (the Delete key does the same).
                GlyphButton {
                    id: trash
                    objectName: "trashConversation"
                    visible: row.chosen && row.modelData.kind === "session" && !row.editing
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad - Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    text: "×"
                    name: "Move to Trash"
                    restColor: Theme.foregroundDim
                    hoverColor: Theme.danger
                    onClicked: root.deleteRequested(row.modelData.id, row.modelData.label)
                }
            }
        }
    }

    Text {
        id: footer
        anchors.top: list.bottom
        anchors.topMargin: Theme.gap
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        height: Theme.fontSizeCaption + Theme.gap * 2
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
        // A refusal is what the owner most needs to read here; then why a typed
        // name offers no summon; then the keys the selected row answers to.
        readonly property bool refused: root.ghostMode && Ghostd.ghostRenameError !== ""
        text: footer.refused ? Ghostd.ghostRenameError
            : root.ghostMode && root.rows.length === 0 && filter.text.trim() !== ""
                ? "a name is letters, digits, . _ or -, up to 64, starting with a letter or digit"
            : root.current && root.current.kind === "session"
                ? "↵ open   ^R rename   ^P pin   del trash   ⇥ ghost   esc close"
            : root.current && root.current.kind === "ghost"
                ? "↵ switch   ^R rename   del banish   esc back"
            : root.ghostMode ? "↵ summon   esc back"
            : "↵ open   ^N new   ⇥ ghost   esc close"
        color: footer.refused ? Theme.ghostRose : Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeCaption
    }
}
