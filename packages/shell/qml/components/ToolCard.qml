pragma ComponentBehavior: Bound

import QtQuick
import qs.services
import "ToolTrace.js" as ToolTrace

Rectangle {
    id: root

    required property var activity
    property bool expanded: false

    readonly property bool running: activity.status === "running"
        || activity.status === "preparing" || activity.status === "queued"
    readonly property bool completed: activity.status === "complete"
    readonly property bool failed: activity.status === "failed"
    readonly property string trace: ToolTrace.text(
        root.activity, root.completed, root.failed, root.expanded)
    readonly property string diagnosticInput: ToolTrace.input(root.activity)
    readonly property var askBranch: activity.askBranch || null
    readonly property bool hasDiagnostics: ToolTrace.hasDiagnostics(root.activity)

    visible: root.trace !== "" || root.askBranch !== null
    implicitHeight: visible ? toolContent.implicitHeight + 12 : 0
    radius: Theme.radius / 2
    color: Theme.surface
    border.width: root.failed ? 1 : 0
    border.color: Theme.danger

    // Declared before the action row so its smaller MouseAreas win hit-testing.
    MouseArea {
        anchors.fill: parent
        cursorShape: root.hasDiagnostics ? Qt.PointingHandCursor : Qt.ArrowCursor
        enabled: root.hasDiagnostics
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
                width: 12
                height: 16

                Rectangle {
                    visible: root.running
                    anchors.centerIn: parent
                    width: 7
                    height: 7
                    radius: 4
                    color: Theme.accent

                    SequentialAnimation on opacity {
                        running: root.running && !Theme.reducedMotion
                        loops: Animation.Infinite
                        NumberAnimation { to: 0.25; duration: 550; easing.type: Easing.InOutQuad }
                        NumberAnimation { to: 1; duration: 550; easing.type: Easing.InOutQuad }
                    }
                }

                Text {
                    visible: !root.running
                    anchors.centerIn: parent
                    text: root.failed ? "×" : "✓"
                    color: root.failed ? Theme.danger : Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    font.weight: Font.DemiBold
                }
            }

            Text {
                width: parent.width - x
                text: root.trace
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                font.weight: Font.DemiBold
                wrapMode: root.expanded ? Text.Wrap : Text.NoWrap
                elide: root.expanded ? Text.ElideNone : Text.ElideRight
            }
        }

        Text {
            visible: root.expanded && root.activity.summary && root.activity.intent
            width: parent.width
            text: "Intent · " + ToolTrace.compact(root.activity.intent, 1200)
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: root.expanded && root.activity.name !== ""
            width: parent.width
            text: "Tool · " + root.activity.name
            color: Theme.foregroundDim
            font.family: Theme.fontFamilyMono
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: root.expanded && root.diagnosticInput !== ""
            width: parent.width
            text: "Input · " + root.diagnosticInput
            color: Theme.foregroundDim
            font.family: Theme.fontFamilyMono
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Row {
            visible: root.activity.name === "ask" && root.askBranch !== null
            width: parent.width
            spacing: Theme.gap

            Text {
                text: "Re-answer"
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
