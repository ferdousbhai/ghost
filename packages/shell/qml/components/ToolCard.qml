pragma ComponentBehavior: Bound

import QtQuick
import qs.services

Rectangle {
    id: root

    required property var activity
    property bool expanded: false

    readonly property bool running: activity.status === "running"
        || activity.status === "preparing" || activity.status === "queued"
    readonly property bool failed: activity.status === "failed"
    readonly property string detail: root.detailText()
    readonly property var askBranch: activity.askBranch || null

    implicitHeight: toolContent.implicitHeight + Theme.gap
    radius: Theme.radius / 2
    color: Theme.surface
    border.width: 1
    border.color: root.failed ? Theme.danger
        : (root.running ? Theme.accent : Theme.muted)

    function titleFor(name: string): string {
        const names = {
            ask: "Asked a question",
            ghost_notes_list: "Listed notes",
            ghost_notes_read: "Read a note",
            ghost_notes_grep: "Searched notes",
            ghost_notes_write: "Wrote a note",
            ghost_memory_list: "Listed memories",
            ghost_memory_read: "Read a memory",
            ghost_memory_write: "Saved a memory",
            look_at_image: "Looked at an image",
            ghost_screen: "Captured the screen",
            ghost_browser: "Used the browser",
            ghost_desktop: "Used the desktop"
        };
        if (names[name]) return names[name];
        return String(name || "tool").replace(/^ghost_/u, "").replaceAll("_", " ");
    }

    function compact(value: string, limit: int): string {
        const oneLine = String(value || "").replace(/\s+/gu, " ").trim();
        return oneLine.length > limit ? oneLine.slice(0, limit - 1) + "…" : oneLine;
    }

    function argumentText(): string {
        const args = root.activity.arguments;
        if (!args || typeof args !== "object") return "";
        if (Array.isArray(args.questions)) {
            const count = args.questions.length;
            return count + (count === 1 ? " question" : " questions");
        }
        const keys = ["query", "path", "name", "url", "action", "prompt", "source"];
        for (const key of keys) {
            if (typeof args[key] === "string" && args[key].trim() !== "")
                return root.compact(args[key], 150);
        }
        const json = JSON.stringify(args);
        return json === "{}" ? "" : root.compact(json, 150);
    }

    function detailText(): string {
        if (root.activity.summary) return root.compact(root.activity.summary, root.expanded ? 1200 : 180);
        if (root.activity.intent) return root.compact(root.activity.intent, root.expanded ? 1200 : 180);
        return root.argumentText();
    }

    // Declared before the action row so its smaller MouseAreas win hit-testing.
    MouseArea {
        anchors.fill: parent
        cursorShape: root.detail === "" ? Qt.ArrowCursor : Qt.PointingHandCursor
        enabled: root.detail !== ""
        onClicked: root.expanded = !root.expanded
    }

    Column {
        id: toolContent
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Theme.gap / 2
        spacing: 3

        Row {
            width: parent.width
            spacing: Theme.gap / 2

            Item {
                width: 14
                height: 16

                Text {
                    anchors.centerIn: parent
                    text: root.failed ? "!" : (root.running ? "●" : "✓")
                    color: root.failed ? Theme.danger
                        : (root.running ? Theme.accent : Theme.foregroundDim)
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    font.bold: true

                    SequentialAnimation on opacity {
                        running: root.running
                        loops: Animation.Infinite
                        NumberAnimation { to: 0.25; duration: 550; easing.type: Easing.InOutQuad }
                        NumberAnimation { to: 1; duration: 550; easing.type: Easing.InOutQuad }
                    }
                }
            }

            Text {
                width: parent.width - x - statusText.implicitWidth - Theme.gap
                text: root.titleFor(root.activity.name)
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                font.bold: true
                elide: Text.ElideRight
            }

            Text {
                id: statusText
                text: root.failed ? "failed"
                    : (root.activity.status === "complete" ? "done"
                        : (root.activity.status === "preparing" ? "preparing"
                            : (root.activity.status === "queued" ? "queued" : "running")))
                color: root.failed ? Theme.danger : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
        }

        Text {
            visible: root.detail !== ""
            width: parent.width
            text: root.detail
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: root.expanded ? Text.Wrap : Text.NoWrap
            elide: root.expanded ? Text.ElideNone : Text.ElideRight
        }

        Text {
            visible: root.expanded && root.argumentText() !== ""
                && root.argumentText() !== root.detail
            width: parent.width
            text: root.argumentText()
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Row {
            visible: root.activity.name === "ask" && root.askBranch !== null
            width: parent.width
            spacing: Theme.gap

            Text {
                text: "re-answer"
                color: Theme.accent
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: Ghostd.reanswerHistoricalAsk(root.askBranch.resultEntryId || "")
                }
            }

            Text {
                visible: root.askBranch && root.askBranch.count > 1
                text: root.askBranch.previousTargetId ? "‹" : "·"
                color: root.askBranch.previousTargetId ? Theme.accent : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    enabled: Boolean(root.askBranch && root.askBranch.previousTargetId)
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: Ghostd.navigateBranch(root.askBranch.previousTargetId)
                }
            }

            Text {
                visible: root.askBranch && root.askBranch.count > 1
                text: (root.askBranch.index + 1) + "/" + root.askBranch.count
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Text {
                visible: root.askBranch && root.askBranch.count > 1
                text: root.askBranch.nextTargetId ? "›" : "·"
                color: root.askBranch.nextTargetId ? Theme.accent : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    enabled: Boolean(root.askBranch && root.askBranch.nextTargetId)
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: Ghostd.navigateBranch(root.askBranch.nextTargetId)
                }
            }
        }
    }
}
