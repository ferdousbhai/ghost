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
    readonly property bool hasDiagnostics: root.presentation.hasDiagnostics

    // Native model-tool paths use the cwd captured when that exact call began.
    // Ghost-owned legacy writers still use the selected ghost home. An older
    // transcript with a relative native path and no cwd offers no chip rather
    // than silently opening a similarly named file in the wrong directory.
    readonly property string workbenchPath: root.completed || root.running
        ? (root.presentation.fileBase === "ghost"
            ? Workbench.absolute(root.presentation.fileTarget)
            : Workbench.absoluteFrom(root.presentation.fileTarget,
                root.presentation.fileCwd)) : ""
    readonly property bool openable: Workbench.canOpen(root.workbenchPath)

    // #fde68a at 90% — the old card's amber-100 label. On paper that wash is
    // unreadable, so light mode keeps the amber fills and takes a plain ink.
    readonly property color labelColor: Theme.light
        ? Theme.foregroundBright : Qt.rgba(0.992, 0.902, 0.541, 0.9)
    readonly property color detailColor: Theme.light ? Theme.foreground : Theme.foregroundDim
    // Rose, the failure temperature, rather than the ordinary amber.
    readonly property color glyphTint: root.failed ? Theme.ghostRose : Theme.ghostAmberBright

    // 16 glyph + the trace Row's own spacing: rows under the trace line up
    // under its words.
    readonly property real indent: 16 + Theme.gap / 2

    visible: root.trace !== ""
    implicitHeight: visible ? toolContent.implicitHeight + 12 : 0
    radius: Theme.bubbleRadiusSmall
    color: cardHover.containsMouse ? Theme.amber(0.08) : Theme.amber(0.05)
    border.width: 1
    border.color: root.failed ? Theme.rose(0.35) : Theme.amber(0.10)

    Behavior on color {
        enabled: !Theme.reducedMotion
        ColorAnimation { duration: Theme.durFast; easing.type: Easing.OutQuad }
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

        // Open-the-file affordance, indented under the trace line rather than
        // beside it: the trace is a full-width elided line, so a sibling in
        // that Row would be the thing that gets elided away.
        Rectangle {
            id: fileChip

            readonly property bool current: Workbench.filePath === root.workbenchPath

            visible: root.openable
            x: root.indent
            width: Math.min(parent.width - x, chipLabel.implicitWidth + Theme.gap * 1.5)
            height: visible ? chipLabel.implicitHeight + 6 : 0
            radius: Theme.bubbleRadiusSmall
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
    }
}
