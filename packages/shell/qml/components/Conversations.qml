pragma ComponentBehavior: Bound

// The conversation list for the selected ghost: every stored thread, which one
// is open, and a way to start a fresh one. Mirrors Roster.qml's shape and
// interaction, one rung down the left panel. Rows come from
// GET /api/ghosts/:name/sessions; opening one loads its transcript (#26), the
// sidebar footer below mints a new session id like "+ new ghost" mints a ghost.
//
// The list is shaped like Apple Notes' sidebar: its section heading and search
// field sit on top, then a "Pinned" group that disappears when it is empty,
// then the rest. Pinned state lives on the daemon row (`pinned`), which also
// owns the ordering; the HUD only splits the already-sorted listing into the
// two groups.
import QtQuick
import qs.services

Item {
    id: root

    /** Emitted after a conversation is opened or a new one is started, so the
        HUD can return focus to the composer. */
    signal picked()

    /** The × was clicked: the HUD raises the modal confirmation. Deleting is
        never one click, and the question is worth more room than a list row. */
    signal deleteRequested(string sessionId, string title)

    /** The live filter. Empty shows every conversation in both groups. */
    readonly property string query: searchInput.text.trim()

    /** The two groups, already filtered. The daemon sorts the listing (pinned
        first, newest-updated first inside each group), so filtering in place
        keeps that order without re-sorting here. */
    readonly property var pinnedSessions: root.group(true)
    readonly property var otherSessions: root.group(false)

    implicitWidth: 190
    implicitHeight: column.implicitHeight

    /** Drop the filter — what a caller outside the list (the sidebar footer's
        compose button) needs before the view jumps to a brand-new
        conversation. */
    function reset(): void {
        searchInput.text = "";
    }

    // A row's display title: the daemon-generated title, or a graceful fallback
    // (an unstarted/just-created thread is "New conversation").
    function titleOf(session: var): string {
        return (session && typeof session.title === "string" && session.title !== "")
            ? session.title
            : "New conversation";
    }

    // Compact "when": a relative age from updatedAt (or createdAt), for the dim
    // right-hand hint. Empty when we have no timestamp to show.
    function whenOf(session: var): string {
        const stamp = session ? (session.updatedAt || session.createdAt || "") : "";
        if (stamp === "") return "";
        const then = Date.parse(stamp);
        if (isNaN(then)) return "";
        const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
        if (secs < 60) return "now";
        if (secs < 3600) return Math.floor(secs / 60) + "m";
        if (secs < 86400) return Math.floor(secs / 3600) + "h";
        return Math.floor(secs / 86400) + "d";
    }

    // Case-insensitive substring match against what the row actually shows, so
    // the "New conversation" fallback title is searchable too.
    function matches(session: var): bool {
        if (root.query === "") return true;
        return root.titleOf(session).toLowerCase().indexOf(root.query.toLowerCase()) !== -1;
    }

    function group(pinned: bool): var {
        return Ghostd.sessions.filter(function (session) {
            return (session && session.pinned === true) === pinned && root.matches(session);
        });
    }

    // One row shape, instantiated by both group Repeaters. Duplicating it per
    // section would be the same delegate twice with a different model.
    Component {
        id: conversationRow

        Rectangle {
            id: entry

            required property var modelData

            readonly property bool active: entry.modelData.id === Ghostd.currentSessionId
            readonly property bool pinned: entry.modelData.pinned === true
            readonly property bool deleting:
                Ghostd.deletingSessionId === entry.modelData.id

            width: root.width
            height: Theme.controlHeight
            radius: Theme.radius / 2
            // Selection reads from the row itself — a stronger film plus the
            // bright title — the way Roster.qml lights its active ghost. Amber
            // stays reserved for state that is not "you are looking at this".
            color: entry.active ? Theme.film(0.14)
                : (entryArea.containsMouse ? Theme.film(0.06) : "transparent")

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast }
            }

            // One line per conversation: the title takes every pixel the row
            // can spare and elides, and the right-hand slot is shared — the age
            // at rest, the pin and close on hover — so nothing reflows as the
            // pointer crosses a row and the sidebar stays a list, not a stack
            // of two-line blocks.
            Item {
                z: 1
                anchors.fill: parent
                anchors.leftMargin: Theme.gap
                anchors.rightMargin: Theme.gap

                Text {
                    id: titleText
                    anchors.left: parent.left
                    anchors.right: actions.left
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    text: root.titleOf(entry.modelData)
                    color: entry.active ? Theme.foregroundBright
                        : (entryArea.containsMouse ? Theme.foreground : Theme.foregroundDim)
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    elide: Text.ElideRight
                }

                Item {
                    id: actions

                    // Two 16px glyphs and the gap between them. The age is
                    // narrower and rides the same slot, right-aligned.
                    readonly property bool showActions: (entryArea.containsMouse
                        || pinArea.containsMouse || deleteArea.containsMouse
                        || entry.deleting)

                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    width: 16 * 2 + Theme.gap / 2
                    height: Theme.controlHeight

                    Text {
                        id: when
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        visible: !actions.showActions
                        text: root.whenOf(entry.modelData)
                        color: Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    Rectangle {
                        id: pinAction
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        width: 16
                        height: Theme.controlHeight
                        // Pinned state reads from which section the row sits in,
                        // the way Notes does it, so this is a hover action and
                        // never a permanent badge.
                        visible: actions.showActions && !entry.deleting
                        z: 2
                        radius: Theme.radius / 2
                        color: pinArea.containsMouse ? Theme.film(0.10) : "transparent"

                        Behavior on color {
                            enabled: !Theme.reducedMotion
                            ColorAnimation { duration: Theme.durFast }
                        }

                        Text {
                            anchors.centerIn: parent
                            text: "⚲"
                            color: entry.pinned
                                ? (pinArea.containsMouse ? Theme.ghostAmberBright : Theme.ghostAmber)
                                : (pinArea.containsMouse ? Theme.foreground : Theme.foregroundFaint)
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                        }

                        MouseArea {
                            id: pinArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            // Pinning is reversible in one click, so it asks nothing.
                            onClicked: Ghostd.pinConversation(entry.modelData.id, !entry.pinned)
                        }
                    }

                    Rectangle {
                        id: deleteAction
                        anchors.right: parent.right
                        anchors.verticalCenter: parent.verticalCenter
                        width: 16
                        height: Theme.controlHeight
                        visible: actions.showActions
                            && !(entry.active && Ghostd.streaming)
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
                            onClicked: root.deleteRequested(entry.modelData.id,
                                root.titleOf(entry.modelData))
                        }
                    }
                }
            }

            MouseArea {
                id: entryArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    Ghostd.openConversation(entry.modelData.id);
                    root.picked();
                }
            }
        }
    }

    Column {
        id: column
        width: root.width
        spacing: Theme.gap

        Text {
            text: "Conversations"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall - 1
            font.weight: Font.DemiBold
            font.capitalization: Font.AllUppercase
            font.letterSpacing: 1
        }

        // ---- Search ------------------------------------------------------
        // Only shown once there is something to search — an empty ghost gets
        // its empty state, not a dead field.
        Rectangle {
            visible: Ghostd.sessions.length > 0
            width: root.width
            height: Theme.controlHeight
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

        // ---- Pinned ------------------------------------------------------
        // Header and rows vanish together when nothing pinned survives the
        // filter; Notes never shows an empty group.
        Text {
            visible: root.pinnedSessions.length > 0
            text: "Pinned"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall - 1
            font.weight: Font.DemiBold
            font.capitalization: Font.AllUppercase
            font.letterSpacing: 1
        }

        Repeater {
            model: root.pinnedSessions
            delegate: conversationRow
        }

        Repeater {
            model: root.otherSessions
            delegate: conversationRow
        }

        Text {
            visible: root.query !== "" && Ghostd.sessions.length > 0
                && root.pinnedSessions.length === 0 && root.otherSessions.length === 0
            width: root.width
            text: "No matches"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: Ghostd.sessionsError !== "" && Ghostd.sessions.length > 0
            width: root.width
            text: Ghostd.sessionsError
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: Ghostd.sessions.length === 0
            width: root.width
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
