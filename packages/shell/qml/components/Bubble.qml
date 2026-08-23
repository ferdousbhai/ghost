pragma ComponentBehavior: Bound

// One transcript row: a user prompt, or a ghost's reply plus its tool trail.
//
// Assistant text renders as Text.MarkdownText — Qt 6 parses CommonMark
// natively, which covers everything a v1 reply needs (emphasis, code spans,
// lists, headings) without shipping a parser. User text renders plain so a
// prompt containing backticks or underscores survives verbatim.
import QtQuick
import qs.services

Item {
    id: root

    required property string speaker
    required property string body
    required property string toolTrail
    required property var activities
    required property string failure
    required property bool busy
    required property string sourceEntryId
    required property var branchNavigation

    readonly property bool mine: root.speaker === "user"

    implicitHeight: card.implicitHeight

    Rectangle {
        id: card

        anchors.right: root.mine ? parent.right : undefined
        anchors.left: root.mine ? undefined : parent.left
        width: root.mine
            ? Math.min(parent.width * 0.82, implicitWidth + Theme.pad * 2)
            : parent.width
        implicitWidth: Math.max(content.implicitWidth, 1) + Theme.pad * 2
        implicitHeight: content.implicitHeight + Theme.pad * 2
        radius: Theme.radius
        color: root.mine ? Theme.selection : Theme.surfaceDeep
        border.width: root.failure === "" ? 0 : 1
        border.color: Theme.danger

        Column {
            id: content
            anchors.fill: parent
            anchors.margins: Theme.pad
            spacing: Theme.gap / 2

            Repeater {
                model: root.activities || []
                delegate: ToolCard {
                    required property var modelData
                    width: content.width
                    activity: modelData
                }
            }

            // Compatibility fallback for older transcript rows that only have
            // the pre-card comma-separated trail.
            Text {
                visible: (!root.activities || root.activities.length === 0)
                    && root.toolTrail !== ""
                width: parent.width
                text: "⚒ " + root.toolTrail
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                elide: Text.ElideRight
            }

            Text {
                width: parent.width
                visible: root.body !== ""
                text: root.body
                textFormat: root.mine ? Text.PlainText : Text.MarkdownText
                color: root.mine ? Theme.foregroundBright : Theme.foreground
                // Monochrome links: the markdown renderer underlines them, so
                // link-ness reads from the underline, not a saturated colour
                // (the palette accent is blue). Restrained, per the design system.
                linkColor: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                wrapMode: Text.Wrap
                onLinkActivated: link => ExternalLinks.openModelUrl(link)
            }

            Row {
                visible: root.mine && root.sourceEntryId !== "" && !root.busy
                spacing: Theme.gap

                Text {
                    text: "branch"
                    color: Theme.accent
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: Ghostd.branchFrom(root.sourceEntryId)
                    }
                }

                Text {
                    visible: root.branchNavigation && root.branchNavigation.count > 1
                    text: root.branchNavigation.previousTargetId ? "‹" : "·"
                    color: root.branchNavigation.previousTargetId ? Theme.accent : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    MouseArea {
                        anchors.fill: parent
                        enabled: Boolean(root.branchNavigation && root.branchNavigation.previousTargetId)
                        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                        onClicked: Ghostd.navigateBranch(root.branchNavigation.previousTargetId)
                    }
                }

                Text {
                    visible: root.branchNavigation && root.branchNavigation.count > 1
                    text: (root.branchNavigation.index + 1) + "/" + root.branchNavigation.count
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                Text {
                    visible: root.branchNavigation && root.branchNavigation.count > 1
                    text: root.branchNavigation.nextTargetId ? "›" : "·"
                    color: root.branchNavigation.nextTargetId ? Theme.accent : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    MouseArea {
                        anchors.fill: parent
                        enabled: Boolean(root.branchNavigation && root.branchNavigation.nextTargetId)
                        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                        onClicked: Ghostd.navigateBranch(root.branchNavigation.nextTargetId)
                    }
                }
            }

            Text {
                visible: root.busy && root.body === ""
                text: "…"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
            }

            Text {
                visible: root.failure !== ""
                width: parent.width
                text: root.failure
                color: Theme.danger
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.Wrap
            }
        }
    }
}
