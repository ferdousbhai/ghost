pragma ComponentBehavior: Bound

// The conversation list for the selected ghost: every stored thread, which one
// is open, and a way to start a fresh one. Mirrors Roster.qml's shape and
// interaction, one rung down the left panel. Rows come from
// GET /api/ghosts/:name/sessions; opening one loads its transcript (#26), the
// button below mints a new session id like "+ new ghost" mints a ghost.
import QtQuick
import qs.services

Item {
    id: root

    /** Emitted after a conversation is opened or a new one is started, so the
        HUD can return focus to the composer. */
    signal picked()

    /** A destructive action takes two clicks; only one row can be armed. */
    property string confirmingSessionId: ""

    implicitWidth: 190
    implicitHeight: column.implicitHeight

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

    Column {
        id: column
        width: root.width
        spacing: Theme.gap

        Text {
            text: "Conversations"
            color: Theme.foreground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.weight: Font.DemiBold
        }

        Repeater {
            model: Ghostd.sessions

            Rectangle {
                id: entry

                required property var modelData

                readonly property bool active: entry.modelData.id === Ghostd.currentSessionId
                readonly property bool confirmingDelete:
                    root.confirmingSessionId === entry.modelData.id
                readonly property bool deleting:
                    Ghostd.deletingSessionId === entry.modelData.id

                width: root.width
                // Grow to fit a wrapped title instead of eliding it.
                height: Math.max(Theme.controlHeight, titleText.implicitHeight + Theme.gap)
                radius: Theme.radius / 2
                color: entry.active ? Theme.selection
                    : (entryArea.containsMouse ? Theme.hover : "transparent")

                Row {
                    z: 1
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.gap
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.gap
                    spacing: Theme.gap

                    Rectangle {
                        anchors.verticalCenter: parent.verticalCenter
                        width: 2
                        height: 18
                        radius: 1
                        visible: entry.active
                        color: Theme.accent
                    }

                    Text {
                        id: titleText
                        anchors.verticalCenter: parent.verticalCenter
                        width: parent.width - 2 - when.width - deleteAction.width - Theme.gap * 3
                        text: root.titleOf(entry.modelData)
                        color: entry.active ? Theme.foregroundBright : Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        wrapMode: Text.WrapAtWordBoundaryOrAnywhere
                    }

                    Text {
                        id: when
                        anchors.verticalCenter: parent.verticalCenter
                        width: implicitWidth
                        text: entry.confirmingDelete || entry.deleting
                            ? ""
                            : root.whenOf(entry.modelData)
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    Item {
                        id: deleteAction
                        anchors.verticalCenter: parent.verticalCenter
                        // Reserve the close affordance even before hover so a
                        // long wrapped title does not jump as the pointer enters.
                        width: entry.confirmingDelete || entry.deleting ? 42 : 16
                        height: Theme.controlHeight
                        visible: (entryArea.containsMouse || deleteArea.containsMouse
                            || entry.confirmingDelete || entry.deleting)
                            && !(entry.active && Ghostd.streaming)
                        z: 2

                        Text {
                            anchors.centerIn: parent
                            text: entry.deleting ? "…"
                                : (entry.confirmingDelete ? "Delete" : "×")
                            color: Theme.danger
                            font.family: Theme.fontFamily
                            font.pixelSize: entry.confirmingDelete
                                ? Theme.fontSizeSmall
                                : Theme.fontSize
                            font.weight: entry.confirmingDelete ? Font.DemiBold : Font.Normal
                        }

                        MouseArea {
                            id: deleteArea
                            anchors.fill: parent
                            enabled: !entry.deleting
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                if (entry.confirmingDelete) {
                                    root.confirmingSessionId = "";
                                    Ghostd.deleteConversation(entry.modelData.id);
                                } else {
                                    root.confirmingSessionId = entry.modelData.id;
                                }
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
                        root.confirmingSessionId = "";
                        Ghostd.openConversation(entry.modelData.id);
                        root.picked();
                    }
                }
            }
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

        // ---- New conversation --------------------------------------------

        Rectangle {
            width: root.width
            height: Theme.controlHeight
            radius: Theme.radius / 2
            color: newConversationArea.containsMouse ? Theme.hover : "transparent"
            border.width: 0
            border.color: Theme.border
            visible: Ghostd.activeGhost !== ""

            Text {
                anchors.left: parent.left
                anchors.leftMargin: Theme.gap
                anchors.verticalCenter: parent.verticalCenter
                text: "+ New conversation"
                color: Theme.foreground
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            MouseArea {
                id: newConversationArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    root.confirmingSessionId = "";
                    Ghostd.newConversation();
                    root.picked();
                }
            }
        }
    }
}
