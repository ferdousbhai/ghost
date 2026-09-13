pragma ComponentBehavior: Bound

// ToolCard — summon-ghost's amber whisper-card. One tool activity, rendered as
// a human-readable trace inside the assistant's own message: a ghost glyph in
// its halo, a light amber line ("Ghost updated memory."), and the diagnostics
// folded away behind a click. Warm amber is the ghost's own temperature; the
// cold spectral blue belongs to the thinking orb, not here.
import QtQuick
import Qt5Compat.GraphicalEffects
import "../services"
import "ToolTrace.js" as ToolTrace

Rectangle {
    id: root

    required property var activity
    property bool expanded: false

    // Delegate destruction clears stored value properties before retiring all
    // bindings that read them. Normalise from the required property on every
    // read: caching this object in another `var` leaves that cache briefly null
    // while the remaining bindings are still taking their final evaluation.
    function call(): var { return root.activity || ({}) }

    readonly property bool running: root.call().status === "running"
        || root.call().status === "preparing" || root.call().status === "queued"
    readonly property bool completed: root.call().status === "complete"
    readonly property bool failed: root.call().status === "failed"
    readonly property var presentation: ToolTrace.view(
        root.call(), root.completed, root.failed, root.expanded)
    readonly property string trace: root.presentation.trace
    readonly property string diagnosticInput: root.presentation.diagnosticInput
    readonly property var askBranch: root.call().askBranch || null
    readonly property bool hasDiagnostics: root.presentation.hasDiagnostics

    // A question the ghost is still holding, or one that closed without an
    // answer. It is not the same event as "read a file", so it stops wearing
    // the same amber.
    readonly property bool askAwaiting: root.presentation.askAwaiting
    readonly property string askPrompt: root.presentation.askPrompt
    readonly property string askDetail: root.presentation.askDetail

    // Native model-tool paths use the cwd captured when that exact call began.
    // Ghost-owned legacy writers still use the selected ghost home. An older
    // transcript with a relative native path and no cwd offers no chip rather
    // than silently opening a similarly named file in the wrong directory.
    readonly property string workbenchPath: root.completed || root.running
        ? (root.presentation.fileBase === "ghost"
            ? Workbench.absolute(root.presentation.fileTarget)
            : Workbench.absoluteFrom(root.presentation.fileTarget,
                root.presentation.fileCwd)) : ""
    readonly property bool openable: root.workbenchPath !== ""
        && Workbench.kindOf(root.workbenchPath) !== ""

    /** Rose, the failure temperature, rather than the ordinary amber. */
    readonly property bool cool: root.failed || root.askAwaiting

    // #fde68a at 90% — the old card's amber-100 label. On paper that wash is
    // unreadable, so light mode keeps the amber fills and takes a plain ink.
    // An unanswered question takes the rose ink instead, but only in dark mode
    // and only for the ask: rose at this weight is thin on paper, and tinting
    // every failed card's words would make the ordinary retry shout.
    readonly property color labelColor: {
        if (Theme.light) return Theme.foregroundBright;
        return root.askAwaiting ? Theme.ghostRose : Qt.rgba(0.992, 0.902, 0.541, 0.9);
    }
    readonly property color detailColor: Theme.light ? Theme.foreground : Theme.foregroundDim
    readonly property color glyphTint: root.cool ? Theme.ghostRose : Theme.ghostAmberBright

    visible: root.trace !== "" || root.askBranch !== null
    implicitHeight: visible ? toolContent.implicitHeight + 12 : 0
    radius: 12
    color: cardHover.containsMouse ? Theme.amber(0.08) : Theme.amber(0.05)
    border.width: 1
    border.color: root.cool ? Theme.rose(0.35) : Theme.amber(0.10)

    Behavior on color {
        enabled: !Theme.reducedMotion
        ColorAnimation { duration: Theme.durFast; easing.type: Easing.OutQuad }
    }

    // Whisper in: the card fades up out of the message rather than snapping
    // into the column. Translate, not `y` — the parent positioner owns `y`.
    opacity: Theme.reducedMotion ? 1 : 0
    scale: Theme.reducedMotion ? 1 : 0.95
    transform: Translate { id: whisperShift; y: Theme.reducedMotion ? 0 : 8 }

    Component.onCompleted: if (!Theme.reducedMotion) whisperIn.start()

    ParallelAnimation {
        id: whisperIn
        NumberAnimation {
            target: root; property: "opacity"; to: 1
            duration: Theme.durMed; easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: root; property: "scale"; to: 1
            duration: Theme.durMed; easing.type: Easing.OutCubic
        }
        NumberAnimation {
            target: whisperShift; property: "y"; to: 0
            duration: Theme.durMed; easing.type: Easing.OutCubic
        }
    }

    // Declared before the action row so its smaller MouseAreas win hit-testing.
    MouseArea {
        id: cardHover
        anchors.fill: parent
        hoverEnabled: root.hasDiagnostics
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
                width: 16
                height: 16
                clip: false

                RadialGradient {
                    anchors.centerIn: parent
                    width: 24
                    height: 24
                    horizontalRadius: width / 2
                    verticalRadius: height / 2
                    gradient: Gradient {
                        GradientStop { position: 0.0; color: Theme.amber(0.15) }
                        GradientStop { position: 0.55; color: Theme.amber(0.06) }
                        GradientStop { position: 1.0; color: "transparent" }
                    }
                }

                GhostGlyph {
                    anchors.centerIn: parent
                    size: 14
                    tint: root.glyphTint
                    strokeWidth: 2

                    SequentialAnimation on opacity {
                        running: root.running && !Theme.reducedMotion
                        loops: Animation.Infinite
                        NumberAnimation { to: 0.45; duration: 750; easing.type: Easing.InOutSine }
                        NumberAnimation { to: 1; duration: 750; easing.type: Easing.InOutSine }
                    }
                }
            }

            Text {
                width: parent.width - x
                text: root.trace
                color: root.labelColor
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                font.weight: Font.Light
                font.letterSpacing: 0.5
                wrapMode: root.expanded ? Text.Wrap : Text.NoWrap
                elide: root.expanded ? Text.ElideNone : Text.ElideRight
            }
        }

        // The question, quoted under its own rule. It sits on the collapsed
        // card rather than behind the expand because it is the only thing here
        // a reader scrolling back has actually lost: the trace says how the
        // question ended, and this says what was asked. The rule is the
        // quotation mark — real quote glyphs collide with a question that
        // already contains a path or a phrase in quotes.
        Row {
            visible: root.askPrompt !== ""
            // 16 glyph + the trace Row's own spacing, so the quote lines up
            // under the words above it.
            x: 16 + Theme.gap / 2
            width: parent.width - x
            spacing: Theme.gap / 2

            Rectangle {
                width: 2
                height: askPromptText.implicitHeight
                radius: 1
                color: root.askAwaiting ? Theme.rose(0.5) : Theme.amber(0.4)
            }

            Text {
                id: askPromptText
                width: parent.width - x
                text: root.askPrompt
                color: Theme.light ? Theme.foreground : Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: root.expanded ? Text.Wrap : Text.NoWrap
                elide: root.expanded ? Text.ElideNone : Text.ElideRight
            }
        }

        // Open-the-file affordance, indented under the trace line rather than
        // beside it: the trace is a full-width elided line, so a sibling in
        // that Row would be the thing that gets elided away.
        Rectangle {
            id: fileChip

            readonly property bool current: Workbench.filePath === root.workbenchPath

            visible: root.openable
            // 16 glyph + the trace Row's own spacing, so the chip starts where
            // the words above it do.
            x: 16 + Theme.gap / 2
            width: Math.min(parent.width - x, chipLabel.implicitWidth + Theme.gap * 1.5)
            height: visible ? chipLabel.implicitHeight + 6 : 0
            radius: Theme.radius / 2
            color: fileChip.current || chipArea.containsMouse
                ? Theme.amber(0.16) : Theme.amber(0.08)
            border.width: 1
            border.color: fileChip.current ? Theme.amber(0.35) : Theme.amber(0.18)

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast; easing.type: Easing.OutQuad }
            }

            Text {
                id: chipLabel
                anchors.centerIn: parent
                width: parent.width - Theme.gap
                text: Workbench.baseName(root.workbenchPath)
                color: Theme.ghostAmber
                font.family: Theme.fontFamilyMono
                font.pixelSize: Theme.fontSizeSmall
                elide: Text.ElideMiddle
            }

            // Smaller than cardHover and declared after it, so a click here
            // opens the file instead of toggling the diagnostics.
            MouseArea {
                id: chipArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: Workbench.open(root.workbenchPath)
            }
        }

        Text {
            visible: root.expanded && root.call().summary && root.call().intent
            width: parent.width
            text: "Intent · " + ToolTrace.compact(root.call().intent, 1200)
            color: root.detailColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        // Carries its own labels — one line per question and per option set —
        // so a multi-part ask reads as a list instead of one wrapped sentence.
        Text {
            visible: root.expanded && root.askDetail !== ""
            width: parent.width
            text: root.askDetail
            color: root.detailColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: root.expanded && root.call().name !== undefined && root.call().name !== ""
            width: parent.width
            text: "Tool · " + root.call().name
            color: root.detailColor
            font.family: Theme.fontFamilyMono
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: root.expanded && root.diagnosticInput !== ""
            width: parent.width
            text: "Input · " + root.diagnosticInput
            color: root.detailColor
            font.family: Theme.fontFamilyMono
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        // A chip, not a word: this is the one thing on the card that acts, and
        // as bare text it read as a stray label rather than something to press.
        // It borrows the file chip's shape so the card has one affordance
        // vocabulary, and stays amber even on an unanswered question — rose
        // here would warn against the very thing it is offering.
        Rectangle {
            id: askRow

            // Bindings evaluate even while invisible, so a null askBranch must
            // read as an empty object rather than a TypeError per property.
            readonly property var nav: root.askBranch || ({})

            visible: root.call().name === "ask" && root.askBranch !== null
            x: 16 + Theme.gap / 2
            width: Math.min(parent.width - x, askLabel.implicitWidth + Theme.gap * 1.5)
            height: visible ? askLabel.implicitHeight + 6 : 0
            radius: Theme.radius / 2
            color: askArea.containsMouse ? Theme.amber(0.16) : Theme.amber(0.08)
            border.width: 1
            border.color: askArea.containsMouse ? Theme.amber(0.35) : Theme.amber(0.18)

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast; easing.type: Easing.OutQuad }
            }

            Text {
                id: askLabel
                anchors.centerIn: parent
                text: root.presentation.askAction
                color: Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            // Smaller than cardHover and declared after it, so pressing this
            // answers the question instead of toggling the diagnostics.
            MouseArea {
                id: askArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: Ghostd.reanswerHistoricalAsk(askRow.nav.resultEntryId || "")
            }

            // Re-answering still commits a sibling in this conversation — that
            // is Ghost's two-phase ask tree, not the branch route — but the
            // shell no longer offers a way to step between those siblings,
            // because the daemon no longer has one to offer.
        }
    }
}
