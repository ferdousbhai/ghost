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
import Quickshell
import "../services"
import "MarkdownSegments.js" as MarkdownSegments

Item {
    id: root

    required property string speaker
    required property string body
    required property var activities
    required property string failure
    required property bool busy
    required property string sourceEntryId
    required property int rowIndex

    signal branchRequested(string entryId)

    readonly property bool mine: root.speaker === "user"
    readonly property bool commandOutput: root.speaker === "command"
    // A prompt and a command's output render verbatim: a prompt carrying
    // backticks or underscores has to survive as it was typed.
    readonly property bool plainBody: root.mine || root.commandOutput
    readonly property int contentInset: root.mine ? 12 : 0

    /**
     * The reply, cut into the blocks that can no longer change and the tail
     * that still can. Qt parses whatever markdown it is handed, whole, so a
     * turn that hands over its accumulated body on every flush tick pays for
     * the whole answer every tick. The settled blocks below are laid out once
     * and then left alone; only `liveTail` is re-read as the reply grows.
     */
    property var blockScan: MarkdownSegments.begin()
    property string liveTail: ""

    ListModel { id: bodyBlocks }

    function renderBody(): void {
        if (root.plainBody) {
            // Verbatim text arrives whole and has no blocks to settle.
            root.blockScan = MarkdownSegments.begin();
            bodyBlocks.clear();
            root.liveTail = root.body;
            return;
        }
        // A settled row will not grow, and saying so lets the answer's last
        // block close instead of riding in the tail with the one before it.
        const step = MarkdownSegments.advance(root.body, root.blockScan, !root.busy);
        // A row the list reused for another message, or a turn re-split once it
        // settled, is not a continuation of what is on screen.
        if (step.reset) bodyBlocks.clear();
        for (const segment of step.segments) bodyBlocks.append({ markdown: segment });
        root.liveTail = step.tail;
    }

    onBodyChanged: root.renderBody()
    onPlainBodyChanged: root.renderBody()
    onBusyChanged: root.renderBody()

    // One block of the body, in the reading column's own type.
    //
    // Qt's markdown renderer owns the parts of the type scale we cannot reach
    // from QML: heading sizes are hard-coded multiples of font.pixelSize (h1
    // 2.0, h2 1.5, h3 1.2), code spans take the system fixed font rather than
    // Theme.fontFamilyMono, and links are underlined with no property to undo
    // it. What is set here is therefore all that Text exposes, and must not
    // grow a markdown post-processor to reach the rest.
    component BodyBlock: Text {
        id: blockText

        textFormat: root.plainBody ? Text.PlainText : Text.MarkdownText
        color: root.mine ? Theme.foregroundBright : Theme.foreground
        // Links wear the ghost's own amber, never Theme.accent — the inherited
        // Omarchy accent is blue in most themes, and reading copy is not a web
        // page.
        linkColor: Theme.ghostAmber
        font.family: root.commandOutput ? Theme.fontFamilyMono : Theme.fontFamily
        font.pixelSize: Theme.fontSize
        lineHeight: Theme.lineHeight
        wrapMode: Text.Wrap
        onLinkActivated: link => ExternalLinks.openModelUrl(link)

        // Hover affordance only: Qt.NoButton lets the press fall through to
        // the Text so link activation still fires.
        MouseArea {
            anchors.fill: parent
            acceptedButtons: Qt.NoButton
            cursorShape: blockText.hoveredLink !== ""
                ? Qt.PointingHandCursor : Qt.ArrowCursor
        }
    }

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

    /**
     * What the row has to show: text, and the actions it earns — a reply to
     * copy or edit, or a trail it is holding back, which is all a turn spent
     * entirely on tool calls has.
     *
     * Asked of the row rather than of the items that show it. An item's
     * `visible` is its *effective* visibility, so a parent that asks a child
     * whether to show itself latches shut: a child inside a hidden parent is
     * hidden whatever it is set to, and Qt emits nothing when that does not
     * change. A row appended empty and filled a moment later — which is every
     * streaming reply — would never open again.
     */
    readonly property bool hasBody: root.body !== ""
    readonly property bool hasActions: !root.busy && (root.mine
        ? (root.hasBody && root.sourceEntryId !== "")
        : (root.hasBody || root.quietToolCount > 0))

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
        // A row the list hands a body before this point — every restored row —
        // has already missed onBodyChanged.
        root.renderBody();
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
        // The ghost's reply still claims the row rather than sitting in a
        // bubble; what it does not claim is a 130-column line on a maximised
        // HUD. The measure only bites past that width.
        width: root.mine
            // The actions are a row under the prompt now, so the capsule has
            // to be wide enough to hold them rather than to sit beside them.
            ? Math.min(parent.width * 0.82,
                Math.max(Math.max(tailText.implicitWidth,
                    root.hasActions ? messageActions.implicitWidth : 0)
                    + root.contentInset * 2, 72))
            : Math.min(parent.width, Theme.readingMeasure)
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
                objectName: "messageHoverArea"

                width: parent.width
                height: implicitHeight
                visible: root.hasBody || root.hasActions
                // The actions row sits below the text, so it is the bottom
                // whenever it is there at all — plus the overhang each control
                // gives its own hit area (the negative margins further down).
                // This Item is what `messageHover` watches, so anything the
                // pointer can touch has to be inside it: a hit area reaching
                // past the bottom edge would make the control fade out just as
                // the pointer arrived on it from below.
                implicitHeight: root.hasActions
                    ? messageActions.y + messageActions.height + Theme.gap / 2
                    : (root.hasBody ? bodyView.implicitHeight : 0)

                HoverHandler {
                    id: messageHover
                    acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
                }

                // The settled blocks, then the one still being written. Each
                // is its own document, which is the whole point — and which is
                // why the space markdown would have left between two blocks
                // has to be put back between them here.
                Column {
                    id: bodyView

                    width: parent.width
                    visible: root.hasBody
                    spacing: Theme.markdownBlockGap

                    Repeater {
                        model: bodyBlocks
                        // Named so a test can watch that a block already on
                        // screen is the same object, with the same text, after
                        // the reply has grown past it.
                        delegate: BodyBlock {
                            required property string markdown
                            objectName: "replyBlock"
                            width: bodyView.width
                            text: markdown
                        }
                    }

                    BodyBlock {
                        id: tailText
                        objectName: "replyTail"
                        width: bodyView.width
                        visible: root.liveTail !== ""
                        text: root.liveTail
                    }
                }

                // The actions sit under the text, never in it. Placing them
                // on the final text line meant positioning them from a hidden
                // TextEdit's end cursor and trusting it to agree with what a
                // Text actually painted — which it cannot for a markdown block
                // that owns its own layout (a code fence, a table, a list), so
                // the controls landed on top of the words. A row of its own
                // costs one line and is right by construction.
                Row {
                    id: messageActions
                    objectName: "messageActions"

                    visible: root.hasActions
                    spacing: Theme.gap
                    x: root.mine
                        ? message.width - width - Theme.gap / 2
                        : Theme.gap / 2
                    y: root.hasBody ? bodyView.implicitHeight + Theme.gap / 2 : 0

                    Item {
                        id: copyAction

                        visible: !root.mine && root.hasBody
                        opacity: messageHover.hovered ? 1 : 0
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
                        objectName: "trailToggle"

                        visible: !root.mine && root.quietToolCount > 0
                        // Hover-revealed like its neighbours, with two cases
                        // that must stay painted: an open trail keeps its own
                        // way shut, and a turn that spent itself entirely on
                        // tool calls has no text to hover over — hiding the
                        // count there leaves a row that reserves height and
                        // draws nothing, with the trail unreachable.
                        opacity: messageHover.hovered || root.toolsOpen
                            || !root.hasBody ? 1 : 0
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
