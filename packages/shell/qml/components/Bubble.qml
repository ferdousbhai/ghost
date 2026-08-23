pragma ComponentBehavior: Bound

// One transcript row: a user prompt, or a ghost's reply plus its tool trail.
//
// Assistant text renders as Text.MarkdownText — Qt 6 parses CommonMark
// natively, which covers everything a v1 reply needs (emphasis, code spans,
// lists, headings) without shipping a parser. User text renders plain so a
// prompt containing backticks or underscores survives verbatim.
//
// Only the user's prompt gets a surface: the warm capsule, 16px round with one
// 2px tail corner. A ghost's reply stays unboxed and full width — the reading
// column is the ghost's, not a bubble in it.
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
    /** Position in the transcript model; gates entrances to freshly arrived rows. */
    required property int rowIndex

    readonly property bool mine: root.speaker === "user"
    readonly property int contentInset: root.mine ? 12 : 0

    implicitHeight: card.implicitHeight

    // Only rows created at the live end of the transcript animate in;
    // scrolling back through history must not replay an entrance.
    function atLiveEnd(): bool {
        const rows = Ghostd.transcript;
        return Boolean(rows) && root.rowIndex >= rows.count - 2;
    }

    transform: Translate {
        id: entranceShift
    }

    Component.onCompleted: {
        if (Theme.reducedMotion || !root.atLiveEnd())
            return;
        root.opacity = 0;
        if (root.mine)
            slideIn.start();
        else
            whisperIn.start();
    }

    // A prompt slides in from the right, under the hand that sent it.
    ParallelAnimation {
        id: slideIn
        NumberAnimation {
            target: root; property: "opacity"; from: 0; to: 1
            duration: 250; easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: entranceShift; property: "x"; from: 16; to: 0
            duration: 250; easing.type: Easing.OutCubic
        }
    }

    // A reply whispers in: no direction, just arrival.
    ParallelAnimation {
        id: whisperIn
        NumberAnimation {
            target: root; property: "opacity"; from: 0; to: 1
            duration: Theme.durMed; easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: entranceShift; property: "y"; from: 8; to: 0
            duration: Theme.durMed; easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: root; property: "scale"; from: 0.95; to: 1
            duration: Theme.durMed; easing.type: Easing.OutCubic
        }
    }

    Item {
        id: card

        anchors.right: root.mine ? parent.right : undefined
        anchors.left: root.mine ? undefined : parent.left
        width: root.mine
            ? Math.min(parent.width * 0.82,
                Math.max(bodyText.implicitWidth + root.contentInset * 2, 72))
            : parent.width
        implicitWidth: Math.max(content.implicitWidth, 1) + root.contentInset * 2
        implicitHeight: content.implicitHeight + root.contentInset * 2

        // The capsule: amber presence at the top, cooling to rose, with the
        // tail corner marking whose message it is.
        Rectangle {
            anchors.fill: parent
            visible: root.mine
            radius: Theme.radiusLarge
            bottomRightRadius: Theme.radiusTail
            border.width: 1
            border.color: Theme.film(0.10)
            gradient: Gradient {
                GradientStop { position: 0.0; color: Theme.amber(0.20) }
                GradientStop { position: 0.55; color: Theme.ember(0.15) }
                GradientStop { position: 1.0; color: Theme.rose(0.10) }
            }
        }

        Column {
            id: content
            anchors.fill: parent
            anchors.margins: root.contentInset
            spacing: Theme.gap / 2

            Repeater {
                model: root.activities || []
                delegate: ToolCard {
                    required property var modelData
                    width: content.width
                    activity: modelData
                }
            }

            Text {
                id: bodyText
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
                    text: "Branch"
                    color: Theme.ghostAmber
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    MouseArea {
                        anchors.fill: parent
                        cursorShape: Qt.PointingHandCursor
                        onClicked: Ghostd.branchFrom(root.sourceEntryId)
                    }
                }

                Text {
                    visible: Boolean(root.branchNavigation && root.branchNavigation.count > 1)
                    text: root.branchNavigation && root.branchNavigation.previousTargetId ? "‹" : "·"
                    color: root.branchNavigation && root.branchNavigation.previousTargetId
                        ? Theme.ghostAmber : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    MouseArea {
                        anchors.fill: parent
                        enabled: Boolean(root.branchNavigation && root.branchNavigation.previousTargetId)
                        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                        onClicked: if (root.branchNavigation)
                            Ghostd.navigateBranch(root.branchNavigation.previousTargetId)
                    }
                }

                Text {
                    visible: Boolean(root.branchNavigation && root.branchNavigation.count > 1)
                    text: root.branchNavigation
                        ? (root.branchNavigation.index + 1) + "/" + root.branchNavigation.count : ""
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                Text {
                    visible: Boolean(root.branchNavigation && root.branchNavigation.count > 1)
                    text: root.branchNavigation && root.branchNavigation.nextTargetId ? "›" : "·"
                    color: root.branchNavigation && root.branchNavigation.nextTargetId
                        ? Theme.ghostAmber : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    MouseArea {
                        anchors.fill: parent
                        enabled: Boolean(root.branchNavigation && root.branchNavigation.nextTargetId)
                        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                        onClicked: if (root.branchNavigation)
                            Ghostd.navigateBranch(root.branchNavigation.nextTargetId)
                    }
                }
            }

            Text {
                id: pending
                visible: root.busy && root.body === ""
                text: "…"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize

                SequentialAnimation on opacity {
                    running: pending.visible && !Theme.reducedMotion
                    loops: Animation.Infinite
                    NumberAnimation { from: 1; to: 0.4; duration: 600; easing.type: Easing.InOutQuad }
                    NumberAnimation { from: 0.4; to: 1; duration: 600; easing.type: Easing.InOutQuad }
                }
            }

            // A failed turn is a card of its own, not a red outline on the row:
            // the recovery text has to read as content, not as damage.
            Rectangle {
                visible: root.failure !== ""
                width: parent.width
                height: failureText.height + Theme.pad
                radius: Theme.radiusLarge
                color: Theme.rose(0.10)
                border.width: 1
                border.color: Theme.rose(0.20)

                Text {
                    id: failureText
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: Theme.pad / 2
                    text: root.failure
                    color: Theme.ghostRose
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.Wrap
                }
            }
        }
    }
}
