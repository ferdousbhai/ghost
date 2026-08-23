pragma ComponentBehavior: Bound

// ToolCard — summon-ghost's amber whisper-card. One tool activity, rendered as
// a human-readable trace inside the assistant's own message: a ghost glyph in
// its halo, a light amber line ("Ghost updated memory."), and the diagnostics
// folded away behind a click. Warm amber is the ghost's own temperature; the
// cold spectral blue belongs to the thinking orb, not here.
import QtQuick
import Qt5Compat.GraphicalEffects
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

    // #fde68a at 90% — the old card's amber-100 label. On paper that wash is
    // unreadable, so light mode keeps the amber fills and takes a plain ink.
    readonly property color labelColor: Theme.light
        ? Theme.foregroundBright : Qt.rgba(0.992, 0.902, 0.541, 0.9)
    readonly property color detailColor: Theme.light ? Theme.foreground : Theme.foregroundDim
    readonly property color glyphTint: root.failed ? Theme.ghostRose : Theme.ghostAmberBright

    visible: root.trace !== "" || root.askBranch !== null
    implicitHeight: visible ? toolContent.implicitHeight + 12 : 0
    radius: 12
    color: cardHover.containsMouse ? Theme.amber(0.08) : Theme.amber(0.05)
    border.width: 1
    border.color: root.failed ? Theme.rose(0.35) : Theme.amber(0.10)

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

        Text {
            visible: root.expanded && root.activity.summary && root.activity.intent
            width: parent.width
            text: "Intent · " + ToolTrace.compact(root.activity.intent, 1200)
            color: root.detailColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        Text {
            visible: root.expanded && root.activity.name !== ""
            width: parent.width
            text: "Tool · " + root.activity.name
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

        Row {
            id: askRow

            // Bindings evaluate even while invisible, so a null askBranch must
            // read as an empty object rather than a TypeError per property.
            readonly property var nav: root.askBranch || ({})

            visible: root.activity.name === "ask" && root.askBranch !== null
            width: parent.width
            spacing: Theme.gap

            Text {
                text: "Re-answer"
                color: Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: Ghostd.reanswerHistoricalAsk(askRow.nav.resultEntryId || "")
                }
            }

            Text {
                visible: askRow.nav.count > 1
                text: askRow.nav.previousTargetId ? "‹" : "·"
                color: askRow.nav.previousTargetId ? Theme.ghostAmber : root.detailColor
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    enabled: Boolean(askRow.nav.previousTargetId)
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: Ghostd.navigateBranch(askRow.nav.previousTargetId)
                }
            }

            Text {
                visible: askRow.nav.count > 1
                text: (askRow.nav.index + 1) + "/" + askRow.nav.count
                color: root.detailColor
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Text {
                visible: askRow.nav.count > 1
                text: askRow.nav.nextTargetId ? "›" : "·"
                color: askRow.nav.nextTargetId ? Theme.ghostAmber : root.detailColor
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    enabled: Boolean(askRow.nav.nextTargetId)
                    cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                    onClicked: Ghostd.navigateBranch(askRow.nav.nextTargetId)
                }
            }
        }
    }
}
