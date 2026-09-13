pragma ComponentBehavior: Bound

// The conversation list for the selected ghost: every stored thread, which one
// is open, and a way to start a fresh one. Mirrors Roster.qml's shape and
// interaction, one rung down the left panel. Rows come from
// GET /api/ghosts/:name/sessions; opening one loads its transcript (#26), the
// sidebar footer below mints a new session id like "+ new ghost" mints a ghost.
//
// The list is shaped like Apple Notes' sidebar: its section heading and search
// field sit on top, then the rows. Starred (pinned) state lives on the daemon
// row (`pinned`), which also owns the ordering; starred conversations arrive first
// in the listing and that order speaks for itself.
import QtQuick
import QtQuick.Layouts
import "../services"

Item {
    id: root

    /** Emitted after a conversation is opened or a new one is started, so the
        HUD can return focus to the composer. */
    signal picked()

    /** The × was clicked: the HUD raises the modal confirmation. Deleting is
        never one click, and the question is worth more room than a list row. */
    signal deleteRequested(string sessionId, string title)

    /** A rename ended, one way or the other. Nothing about the view changed —
        the keyboard just has nowhere to be. */
    signal refocused()

    // The rename state lives on the list rather than on the row, and has to:
    // the listing is replaced wholesale on every re-list (a finished turn does
    // one), which rebuilds every delegate underneath a half-typed name.
    readonly property RenameSession rename: RenameSession {
        commit: (id, draft) => Ghostd.renameConversation(id, draft)
        onFinished: root.refocused()
    }

    readonly property string query: searchInput.text.trim()

    readonly property var filteredSessions: Ghostd.sessions.filter(root.matches)

    implicitWidth: Theme.sidebarMeasure
    implicitHeight: 240

    /** Drop the filter — what a caller outside the list (the sidebar footer's
        compose button) needs before the view jumps to a brand-new
        conversation. */
    function reset(): void {
        searchInput.text = "";
    }

    /** Open the field on a row, seeded with the name it actually has — never
        with the "New conversation" placeholder, which is not a name and must
        not become one just because the owner pressed Enter. */
    function beginRename(session: var): void {
        if (!session) return;
        root.rename.begin(session.id,
            typeof session.title === "string" ? session.title : "");
    }

    Connections {
        target: Ghostd

        // A name typed into one ghost's list has no meaning in another's.
        function onActiveGhostChanged(): void {
            root.rename.cancel();
        }

        function onSessionsChanged(): void {
            root.syncRows();
        }
    }

    onQueryChanged: root.syncRows()
    Component.onCompleted: root.syncRows()

    // A row's display title: the daemon-generated title, or a graceful fallback
    // (an unstarted/just-created thread is "New conversation").
    function titleOf(session: var): string {
        return (session && typeof session.title === "string" && session.title !== "")
            ? session.title
            : "New conversation";
    }

    // Case-insensitive substring match against what the row actually shows, so
    // the "New conversation" fallback title is searchable too.
    function matches(session: var): bool {
        if (root.query === "") return true;
        return root.titleOf(session).toLowerCase().indexOf(root.query.toLowerCase()) !== -1;
    }

    /**
     * Reconcile by id so ListView observes true moves instead of a model reset.
     * That is what lets remote turn completions visibly climb the list.
     */
    function syncRows(): void {
        const wanted = root.filteredSessions;
        for (let index = conversationModel.count - 1; index >= 0; index--) {
            const id = conversationModel.get(index).sessionId;
            if (!wanted.some(session => session.id === id)) conversationModel.remove(index);
        }
        for (let target = 0; target < wanted.length; target++) {
            const session = wanted[target];
            let current = -1;
            for (let index = target; index < conversationModel.count; index++) {
                if (conversationModel.get(index).sessionId === session.id) {
                    current = index;
                    break;
                }
            }
            if (current < 0) conversationModel.insert(target, {
                sessionId: session.id,
                sessionData: session
            });
            else {
                if (current !== target) conversationModel.move(current, target, 1);
                conversationModel.set(target, {
                    sessionId: session.id,
                    sessionData: session
                });
            }
        }
    }

    ListModel { id: conversationModel }

    // One stable row shape; ListModel.move keeps it alive during reorder.
    Component {
        id: conversationRow

        Rectangle {
            id: entry

            required property var sessionData

            readonly property bool active: entry.sessionData.id === Ghostd.currentSessionId
            readonly property bool pinned: entry.sessionData.pinned === true
            readonly property bool unread: entry.sessionData.unread === true && !entry.active
            readonly property bool live: Ghostd.isConversationStreaming(
                Ghostd.activeGhost, entry.sessionData.id)
            readonly property bool deleting:
                Ghostd.deletingSessionId === entry.sessionData.id
            readonly property bool editing: root.rename.editingKey === entry.sessionData.id

            width: root.width
            height: Theme.controlHeight
            radius: Theme.radius / 2
            // Selection reads from the row itself — a stronger film plus the
            // bright title — the way Roster.qml lights its active ghost. Amber
            // stays reserved for state that is not "you are looking at this".
            color: entry.active ? Theme.film(0.14)
                : (entryArea.containsMouse ? Theme.film(0.06) : "transparent")
            // The amber ring is the roster's own "you are typing a name here".
            border.width: entry.editing ? 1 : 0
            border.color: Theme.amber(0.50)

            // Both paths matter: the row may already exist when the rename
            // starts, or be rebuilt by a re-list while it is running.
            onEditingChanged: if (entry.editing) titleEdit.begin(root.rename.draft)
            Component.onCompleted: if (entry.editing) titleEdit.begin(root.rename.draft)

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast }
            }

            // One line per conversation: a star, then the title, then the
            // edge of the sidebar. The star is the watchlist pattern — always
            // there, hollow until you star it, filled amber once you have —
            // so starring is one click and the list says what is starred
            // without a hover. The close only takes its width while the
            // pointer is on the row, and takes it back smoothly.
            Item {
                z: 1
                anchors.fill: parent
                anchors.leftMargin: Theme.gap / 2
                anchors.rightMargin: Theme.gap

                Rectangle {
                    id: starAction
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    width: Theme.controlHeight - Theme.gap
                    height: Theme.controlHeight - Theme.gap
                    visible: !entry.editing
                    z: 2
                    radius: Theme.radius / 2
                    color: starArea.containsMouse ? Theme.film(0.10) : "transparent"

                    Accessible.role: Accessible.Button
                    Accessible.name: entry.pinned ? "Unstar conversation" : "Star conversation"

                    Behavior on color {
                        enabled: !Theme.reducedMotion
                        ColorAnimation { duration: Theme.durFast }
                    }

                    Text {
                        anchors.centerIn: parent
                        text: entry.pinned ? "★" : "☆"
                        color: entry.pinned
                            ? (starArea.containsMouse ? Theme.ghostAmberBright : Theme.ghostAmber)
                            : (starArea.containsMouse ? Theme.foreground
                                : (entryArea.containsMouse ? Theme.foregroundDim : Theme.foregroundFaint))
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                    }

                    MouseArea {
                        id: starArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        // Starring is reversible in one click, so it asks nothing.
                        onClicked: Ghostd.pinConversation(entry.sessionData.id, !entry.pinned)
                    }
                }

                Text {
                    id: titleText
                    visible: !entry.editing
                    anchors.left: starAction.right
                    anchors.leftMargin: Theme.gap / 2
                    anchors.right: actions.left
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.titleOf(entry.sessionData)
                    color: entry.active ? Theme.foregroundBright
                        : (entryArea.containsMouse ? Theme.foreground : Theme.foregroundDim)
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    elide: Text.ElideRight
                }

                // The name becomes a field where it is read. It takes the star
                // and the × with it: a row being renamed is not a row you are
                // about to star or delete.
                InlineRename {
                    id: titleEdit
                    visible: entry.editing
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.gap / 2
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    placeholder: "Name this conversation"
                    // Every row carries one of these, and an idle one reports
                    // its own empty text on creation; only the live one speaks.
                    onEdited: value => { if (entry.editing) root.rename.draft = value; }
                    onCommitted: root.rename.commitRename()
                    onCancelled: root.rename.cancel()
                    onFocusGained: root.rename.editor = titleEdit
                    onFocusLost: Qt.callLater(root.rename.commitOnBlur)
                }

                Item {
                    id: actions

                    readonly property bool showActions: !entry.editing
                        && (entryArea.containsMouse || deleteArea.containsMouse
                        || entry.deleting)

                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    // At rest this is one status slot. Hover turns the same
                    // right edge into the delete action and hides the marker.
                    width: 16
                    height: Theme.controlHeight
                    clip: true

                    Behavior on width {
                        enabled: !Theme.reducedMotion
                        NumberAnimation { duration: Theme.durFast; easing.type: Easing.OutCubic }
                    }

                    Rectangle {
                        id: stateMarker
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        width: 6
                        height: 6
                        radius: 3
                        visible: !actions.showActions && (entry.live || entry.unread)
                        color: Theme.ghostAmber

                        SequentialAnimation on opacity {
                            running: stateMarker.visible && entry.live && !Theme.reducedMotion
                            loops: Animation.Infinite
                            NumberAnimation { to: 0.28; duration: 650; easing.type: Easing.InOutSine }
                            NumberAnimation { to: 1; duration: 650; easing.type: Easing.InOutSine }
                        }
                    }

                    Rectangle {
                        id: deleteAction
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        width: 16
                        height: Theme.controlHeight
                        visible: actions.showActions
                            && !entry.live
                        z: 2
                        radius: Theme.radius / 2
                        color: deleteArea.containsMouse || entry.deleting
                            ? Theme.rose(0.10)
                            : "transparent"

                        Behavior on color {
                            enabled: !Theme.reducedMotion
                            ColorAnimation { duration: Theme.durFast }
                        }

                        Text {
                            anchors.centerIn: parent
                            text: entry.deleting ? "…" : "×"
                            color: deleteArea.containsMouse || entry.deleting
                                ? Theme.ghostRose
                                : Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                        }

                        MouseArea {
                            id: deleteArea
                            anchors.fill: parent
                            enabled: !entry.deleting
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.deleteRequested(entry.sessionData.id,
                                root.titleOf(entry.sessionData))
                        }
                    }
                }
            }

            MouseArea {
                id: entryArea
                anchors.fill: parent
                // While the field is up the row is the field; a stray click on
                // the padding around it must not reopen the conversation.
                enabled: !entry.editing
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    Ghostd.openConversation(entry.sessionData.id);
                    root.picked();
                }
                // The first click of the pair still opens the conversation.
                // That is what a single click there does anyway, and it is the
                // one you are about to rename.
                onDoubleClicked: root.beginRename(entry.sessionData)
            }
        }
    }

    ColumnLayout {
        id: column
        anchors.fill: parent
        spacing: Theme.gap

        Text {
            Layout.fillWidth: true
            text: "Conversations"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeCaption
            font.weight: Font.DemiBold
            font.capitalization: Font.AllUppercase
            font.letterSpacing: 1
        }

        // Only shown once there is something to search — an empty ghost gets
        // its empty state, not a dead field.
        Rectangle {
            visible: Ghostd.sessions.length > 0
            Layout.fillWidth: true
            Layout.preferredHeight: Theme.controlHeight
            radius: Theme.radius / 2
            color: searchInput.activeFocus ? Theme.film(0.10) : Theme.film(0.06)

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast }
            }

            Text {
                id: magnifier
                anchors.left: parent.left
                anchors.leftMargin: Theme.gap
                anchors.verticalCenter: parent.verticalCenter
                text: "⌕"
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
            }

            // Plain TextInput rather than QtQuick.Controls TextField, for the
            // reason Composer.qml spells out: Controls drags a whole style stack
            // into a shell that themes itself from Omarchy.
            TextInput {
                id: searchInput
                anchors.left: magnifier.right
                anchors.leftMargin: Theme.gap / 2
                anchors.right: clearSearch.left
                anchors.rightMargin: Theme.gap / 2
                anchors.verticalCenter: parent.verticalCenter
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                selectByMouse: true
                selectionColor: Theme.selection
                clip: true

                // Esc empties the field. An already-empty field is not the
                // user's target, so the key travels on to the HUD.
                Keys.onEscapePressed: event => {
                    event.accepted = searchInput.text !== "";
                    searchInput.text = "";
                }

                Text {
                    anchors.left: parent.left
                    anchors.verticalCenter: parent.verticalCenter
                    visible: searchInput.text === ""
                    text: "Search"
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }
            }

            Item {
                id: clearSearch
                anchors.right: parent.right
                anchors.rightMargin: Theme.gap / 2
                anchors.verticalCenter: parent.verticalCenter
                width: searchInput.text === "" ? 0 : 20
                height: parent.height
                visible: searchInput.text !== ""

                Text {
                    anchors.centerIn: parent
                    text: "×"
                    color: clearArea.containsMouse ? Theme.foreground : Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                }

                MouseArea {
                    id: clearArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: searchInput.text = ""
                }
            }
        }

        ListView {
            id: conversationList
            visible: count > 0
            Layout.fillWidth: true
            Layout.fillHeight: visible
            Layout.minimumHeight: visible ? Theme.controlHeight : 0
            clip: true
            spacing: 0
            model: conversationModel
            delegate: conversationRow

            move: Transition {
                NumberAnimation {
                    properties: "x,y"
                    duration: Theme.reducedMotion ? 0 : 220
                    easing.type: Easing.OutCubic
                }
            }
            displaced: Transition {
                NumberAnimation {
                    properties: "x,y"
                    duration: Theme.reducedMotion ? 0 : 220
                    easing.type: Easing.OutCubic
                }
            }
        }

        Text {
            visible: root.query !== "" && Ghostd.sessions.length > 0
                && root.filteredSessions.length === 0
            Layout.fillWidth: true
            text: "No matches"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: Ghostd.sessionsError !== "" && Ghostd.sessions.length > 0
            Layout.fillWidth: true
            text: Ghostd.sessionsError
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: Ghostd.sessions.length === 0
            Layout.fillWidth: true
            text: Ghostd.activeGhost === ""
                ? "No ghost selected"
                : (Ghostd.sessionsError !== "" ? "Conversations unavailable" : "No conversations yet")
            color: Ghostd.sessionsError !== "" ? Theme.danger : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }
    }
}
