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
import QtQuick
import "../services"
import "Launcher.js" as Launcher

FocusScope {
    id: root

    /** A row was chosen, or Ctrl+N: { kind: "new" | "ask" | "session" | "place", id, detail }. */
    signal activated(var row)
    signal deleteRequested(string sessionId, string title)

    property real maxListHeight: 480
    property real now: Date.now()

    readonly property var rows: Launcher.rows(filter.text, Ghostd.sessions, Ghostd.activeGhost, root.now,
        Ghostd.activeHookCount)
    property int selected: Launcher.first(root.rows)
    readonly property var current: root.selected >= 0 && root.selected < root.rows.length
        ? root.rows[root.selected] : null

    // Held here, not on the row: a re-list rebuilds every delegate, under a
    // half-typed name.
    readonly property RenameSession rename: RenameSession {
        commit: (id, draft) => Ghostd.renameConversation(id, draft)
        onFinished: filter.forceActiveFocus()
    }

    readonly property int rowHeight: Theme.controlHeight + Theme.gap * 2
    readonly property int headerRowHeight: Theme.fontSizeCaption + Theme.gap * 3

    implicitHeight: header.height + 1 + list.height + footer.height + Theme.gap * 2

    onRowsChanged: root.selected = Launcher.first(root.rows)

    /** Fresh on every open: an empty filter, the newest conversations, the keyboard here. */
    function reset(): void {
        filter.text = "";
        root.now = Date.now();
        root.selected = Launcher.first(root.rows);
        list.positionViewAtBeginning();
        filter.forceActiveFocus();
    }

    function move(direction: int): void {
        root.selected = Launcher.step(root.rows, root.selected, direction);
        list.positionViewAtIndex(root.selected, ListView.Contain);
    }

    function nextGhost(): void {
        const names = Ghostd.ghosts.map(g => g.name);
        if (names.length < 2) return;
        Ghostd.selectGhost(names[(names.indexOf(Ghostd.activeGhost) + 1) % names.length]);
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

        SpectralOrb {
            id: orb
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            diameter: Theme.fontSizeTitle + 8
            turnKey: "launcher"
        }

        TextInput {
            id: filter
            objectName: "launcherFilter"
            anchors.left: orb.right
            anchors.leftMargin: Theme.gap * 1.5
            anchors.right: ghostChip.left
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
                text: Ghostd.activeGhost === "" ? "Search" : "Search, or ask " + Ghostd.activeGhost + "…"
                color: Theme.foregroundFaint
                font: filter.font
            }

            Keys.onPressed: event => {
                const ctrl = (event.modifiers & Qt.ControlModifier) !== 0;
                if (event.key === Qt.Key_Down || (ctrl && event.key === Qt.Key_J)) root.move(1);
                else if (event.key === Qt.Key_Up || (ctrl && event.key === Qt.Key_K)) root.move(-1);
                else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) root.activate(root.current);
                else if (event.key === Qt.Key_Tab) root.nextGhost();
                else if (ctrl && event.key === Qt.Key_N) root.activated({ kind: "new", id: "new" });
                else if (ctrl && event.key === Qt.Key_P && root.current && root.current.kind === "session")
                    Ghostd.pinConversation(root.current.id, !root.current.pinned);
                else if (ctrl && event.key === Qt.Key_R && root.current && root.current.kind === "session")
                    root.rename.begin(root.current.id, root.current.title);
                else if (event.key === Qt.Key_Delete && filter.cursorPosition === filter.text.length
                        && root.current && root.current.kind === "session")
                    root.deleteRequested(root.current.id, root.current.label);
                else return;
                event.accepted = true;
            }
        }

        // Whose launcher this is; Tab or a click moves to the next ghost.
        Text {
            id: ghostChip
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            text: Ghostd.activeGhost + (Ghostd.ghosts.length > 1 ? "  ⇥" : "")
            color: chipArea.containsMouse ? Theme.menuSelectedText : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall

            MouseArea {
                id: chipArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.nextGhost()
            }
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
            readonly property bool editing: row.modelData.kind === "session"
                && root.rename.editingKey === row.modelData.id

            onEditingChanged: if (row.editing) renameField.begin(root.rename.draft)
            Component.onCompleted: if (row.editing) renameField.begin(root.rename.draft)

            width: list.width
            height: row.header ? root.headerRowHeight : root.rowHeight

            Text {
                visible: row.header
                anchors.left: parent.left
                anchors.leftMargin: Theme.pad - Theme.gap
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

                // The mark: a place's glyph, a running turn's orb, an unread
                // dot, a pin, or the ghost's own mark for asking it.
                Item {
                    id: mark
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad - Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    width: Theme.fontSize + 6
                    height: width

                    GhostGlyph {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "place" || row.modelData.kind === "ask"
                        size: Theme.fontSize + 2
                        path: row.modelData.kind === "place" ? row.modelData.icon
                            : "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8zM9 10h.01M15 10h.01"
                        tint: row.chosen ? Theme.menuSelectedText : Theme.foregroundDim
                    }

                    SpectralOrb {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "session" && row.modelData.running === true
                        diameter: Theme.fontSize
                        turnKey: row.modelData.id
                    }

                    Rectangle {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "session" && row.modelData.running !== true
                            && row.modelData.unread === true
                        width: 6
                        height: 6
                        radius: 3
                        color: Theme.ghostAmber
                    }

                    Text {
                        anchors.centerIn: parent
                        visible: row.modelData.kind === "session" && row.modelData.running !== true
                            && row.modelData.unread !== true && row.modelData.pinned === true
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
                    placeholder: "Name this conversation"
                    session: root.rename
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
                    font.pixelSize: Theme.fontSizeSmall
                }

                Text {
                    id: meta
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad - Theme.gap
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
            }
        }
    }

    Text {
        id: footer
        anchors.top: list.bottom
        anchors.topMargin: Theme.gap
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        height: Theme.fontSizeCaption + Theme.gap * 2
        verticalAlignment: Text.AlignVCenter
        text: root.current && root.current.kind === "session"
            ? "↵ open   ^R rename   ^P pin   del trash   ⇥ ghost   esc close"
            : "↵ open   ^N new   ⇥ ghost   esc close"
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeCaption
    }
}
