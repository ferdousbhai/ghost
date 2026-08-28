pragma ComponentBehavior: Bound

// One transcript row: a user prompt, or a ghost's reply plus its tool trail.
//
// Assistant text renders as Text.MarkdownText — Qt 6 parses CommonMark
// natively, which covers everything a v1 reply needs (emphasis, code spans,
// lists, headings) without shipping a parser. User text renders plain so a
// prompt containing backticks or underscores survives verbatim.
//
// Qt's markdown renderer owns the parts of the type scale we cannot reach from
// QML: heading sizes are hard-coded multiples of font.pixelSize (h1 2.0, h2
// 1.5, h3 1.2), code spans take the system fixed font rather than
// Theme.fontFamilyMono, and links are underlined with no property to undo it.
// The reading pass is therefore confined to what Text exposes — family, size,
// lineHeight, colour, linkColor — and must not grow a markdown post-processor
// to reach the rest.
//
// Only the user's prompt gets a surface: the warm capsule, 16px round with one
// 2px tail corner. A ghost's reply stays unboxed and full width — the reading
// column is the ghost's, not a bubble in it.
import QtQuick
import Quickshell
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
    required property int rowIndex

    signal branchRequested(string entryId)

    readonly property bool mine: root.speaker === "user"
    readonly property bool commandOutput: root.speaker === "command"
    readonly property int contentInset: root.mine ? 12 : 0

    /**
     * Which tool cards this row shows. Which tools ran is not what a reply is
     * about — the orb narrated that while it happened, and then it stopped
     * being interesting — so a settled turn keeps only the calls a reader still
     * needs: the ones that failed, because a silent failure is how you get a
     * confidently wrong answer, and `ask`, whose card carries the re-answer
     * branch. Everything else is one click away, never in the reading column.
     */
    property bool toolsOpen: false
    // A JS array handed to a ListModel role comes back out as a nested
    // QQmlListModel, which has `count` and no `filter`, so a rehydrated row
    // would throw here and render no cards at all. Copy to a real array once.
    readonly property var allActivities: {
        const value = root.activities;
        if (!value) return [];
        if (Array.isArray(value)) return value;
        const list = [];
        for (let i = 0; i < value.count; i++) list.push(value.get(i));
        return list;
    }
    readonly property var loudActivities: root.allActivities.filter(item =>
        item.status === "failed" || item.name === "ask")
    readonly property var shownActivities: root.toolsOpen
        ? root.allActivities
        : root.loudActivities
    readonly property int quietToolCount:
        root.allActivities.length - root.loudActivities.length

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
                Math.max(bodyText.implicitWidth
                    + (messageActions.visible
                        ? messageActions.implicitWidth + Theme.gap : 0)
                    + root.contentInset * 2, 72))
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
                model: root.shownActivities
                delegate: ToolCard {
                    required property var modelData
                    width: content.width
                    activity: modelData
                }
            }

            Item {
                id: message

                width: parent.width
                height: implicitHeight
                visible: bodyText.visible || messageActions.visible
                implicitHeight: Math.max(
                    bodyText.visible ? bodyText.implicitHeight : 0,
                    messageActions.visible
                        ? messageActions.y + messageActions.height : 0)

                HoverHandler {
                    id: messageHover
                    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                }

                Text {
                    id: bodyText

                    width: parent.width
                    visible: root.body !== ""
                    text: root.body
                    textFormat: root.mine || root.commandOutput
                        ? Text.PlainText : Text.MarkdownText
                    color: root.mine ? Theme.foregroundBright : Theme.foreground
                    // Links wear the ghost's own amber, never Theme.accent — the
                    // inherited Omarchy accent is blue in most themes, and reading
                    // copy is not a web page.
                    linkColor: Theme.ghostAmber
                    font.family: root.commandOutput
                        ? Theme.fontFamilyMono : Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    lineHeight: Theme.lineHeight
                    wrapMode: Text.Wrap
                    onLinkActivated: link => ExternalLinks.openModelUrl(link)

                    // Hover affordance only: Qt.NoButton lets the press fall
                    // through to the Text so link activation still fires.
                    MouseArea {
                        anchors.fill: parent
                        acceptedButtons: Qt.NoButton
                        cursorShape: bodyText.hoveredLink !== ""
                            ? Qt.PointingHandCursor : Qt.ArrowCursor
                    }
                }

                // QQuickText does not expose cursor geometry for rich text,
                // and lineLaidOut only reports its plain-text path. A hidden,
                // read-only document gives us the horizontal end cursor for
                // both formats without changing the rendered typography.
                TextEdit {
                    id: bodyMeasure

                    readonly property rect endRect: {
                        // A method call alone is not a binding dependency. The
                        // geometry reads make the cursor follow reflow as the
                        // HUD or the user capsule changes width.
                        bodyMeasure.width;
                        bodyMeasure.contentHeight;
                        return bodyMeasure.positionToRectangle(bodyMeasure.length);
                    }

                    width: parent.width
                    visible: false
                    readOnly: true
                    text: root.body
                    textFormat: root.mine || root.commandOutput
                        ? TextEdit.PlainText : TextEdit.MarkdownText
                    font.family: root.commandOutput
                        ? Theme.fontFamilyMono : Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    wrapMode: TextEdit.Wrap
                }

                // Settled actions sit on the final text line instead of
                // claiming a line of their own. If the last line reaches the
                // reading edge, they wrap below it like any other inline item.
                Row {
                    id: messageActions

                    readonly property real finalLineHeight:
                        bodyMeasure.endRect.height * bodyText.lineHeight
                    readonly property real inlineX: bodyMeasure.endRect.x
                        + Theme.gap
                    readonly property bool fitsInline: root.body !== ""
                        && messageActions.inlineX + messageActions.implicitWidth
                            <= message.width

                    // A ghost's row earns actions for its reply or for the
                    // trail it is holding back. A turn spent entirely on tool
                    // calls has only the latter.
                    visible: !root.busy && (root.mine
                        ? (root.body !== "" && root.sourceEntryId !== "")
                        : (root.body !== "" || root.quietToolCount > 0))
                    spacing: Theme.gap
                    x: messageActions.fitsInline ? messageActions.inlineX : 0
                    y: messageActions.fitsInline
                        ? bodyText.implicitHeight
                            - (messageActions.finalLineHeight + height) / 2
                        : (bodyText.visible
                            ? bodyText.implicitHeight + Theme.gap / 2 : 0)

                    Item {
                        id: copyAction

                        visible: !root.mine && root.body !== ""
                        width: 16
                        height: 16
                        Accessible.role: Accessible.Button
                        Accessible.name: "Copy message"

                        CopyGlyph {
                            anchors.fill: parent
                            size: copyAction.width
                            tint: copyArea.containsMouse
                                ? Theme.foreground : Theme.foregroundFaint
                        }

                        MouseArea {
                            id: copyArea
                            anchors.fill: parent
                            anchors.margins: -Theme.gap / 2
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Quickshell.clipboardText = root.body
                        }
                    }

                    Item {
                        id: editAction

                        visible: root.mine && root.sourceEntryId !== ""
                        // A running turn owns the conversation. On hover it
                        // stays dimmed, so the click can answer above the
                        // composer instead of vanishing under the pointer.
                        opacity: messageHover.hovered
                            ? (Ghostd.streaming ? 0.4 : 1) : 0
                        width: 16
                        height: 16
                        Accessible.role: Accessible.Button
                        Accessible.name: "Edit message"

                        PencilGlyph {
                            width: parent.width
                            height: parent.height
                            y: -1
                            size: editAction.width
                            tint: editArea.containsMouse
                                ? Theme.ghostAmberBright : Theme.foregroundFaint
                        }

                        MouseArea {
                            id: editArea
                            anchors.fill: parent
                            anchors.margins: -Theme.gap / 2
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            // The HUD owns what happens next: editing copies
                            // the thread into a new conversation and hands
                            // this message's text to the composer, which may
                            // already hold something worth asking about first.
                            onClicked: root.branchRequested(root.sourceEntryId)
                        }
                    }

                    // No sibling navigator lives here any more. An edit starts
                    // its own conversation, so the way back to the other answer
                    // is the sidebar — where every other thread is reached.

                    // The trail, for when something did need checking after
                    // all. A count rather than a glyph: it is the only thing
                    // here that has to say how much it is hiding.
                    Text {
                        id: trailToggle

                        visible: !root.mine && root.quietToolCount > 0
                        text: root.toolsOpen
                            ? "hide"
                            : root.quietToolCount + (root.quietToolCount === 1 ? " step" : " steps")
                        color: trailArea.containsMouse ? Theme.ghostAmber : Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        font.letterSpacing: 0.5
                        Accessible.role: Accessible.Button
                        Accessible.name: root.toolsOpen
                            ? "Hide what the ghost did" : "Show what the ghost did"

                        Behavior on color {
                            enabled: !Theme.reducedMotion
                            ColorAnimation { duration: Theme.durFast; easing.type: Easing.OutQuad }
                        }

                        MouseArea {
                            id: trailArea
                            anchors.fill: parent
                            anchors.margins: -Theme.gap / 2
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.toolsOpen = !root.toolsOpen
                        }
                    }
                }
            }

            // No placeholder for a reply that has not started. The orb below
            // the transcript is already saying the ghost is working, in its own
            // words where it gave any, and an empty row is quieter than the
            // same news told twice.

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
                    lineHeight: Theme.lineHeight
                    wrapMode: Text.Wrap
                }
            }
        }
    }
}
