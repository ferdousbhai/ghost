pragma ComponentBehavior: Bound

// The input field. Enter sends (or queues a follow-up while the ghost is
// working), Shift+Enter opens a new line, Esc bubbles up to the HUD so a
// half-typed prompt is never a reason you can't dismiss.
//
// Plain TextEdit rather than QtQuick.Controls TextArea: Controls would pull in
// a style whose colours would compete with the shared neutral design tokens.
import QtQuick
import Qt5Compat.GraphicalEffects
import "../services"

Item {
    id: root

    signal submitted(string text)

    property alias text: field.text

    /** The tallest the field grows before it scrolls; the HUD sets it from its height. */
    property int maxHeight: 160

    implicitHeight: Math.min(Math.max(field.implicitHeight + Theme.pad, 48), root.maxHeight)

    function take(): void {
        field.forceActiveFocus();
    }

    // Focus halo: the warm bloom the old app put behind a focused input. It
    // sits outside the surface bounds and under it, so it never tints the film.
    RadialGradient {
        anchors.fill: surface
        anchors.margins: -Theme.pad
        horizontalRadius: width / 2
        verticalRadius: height / 2
        opacity: field.activeFocus ? 1 : 0
        gradient: Gradient {
            GradientStop { position: 0.0; color: Theme.amber(0.10) }
            GradientStop { position: 0.45; color: Theme.ember(0.05) }
            GradientStop { position: 0.78; color: Theme.rose(0.04) }
            GradientStop { position: 1.0; color: "transparent" }
        }

        Behavior on opacity {
            enabled: !Theme.reducedMotion
            NumberAnimation { duration: Theme.durSlow; easing.type: Easing.OutCubic }
        }
    }

    Rectangle {
        id: surface

        anchors.fill: parent
        radius: Theme.bubbleRadius
        color: field.activeFocus ? Theme.film(0.07) : Theme.film(0.05)
        border.width: 1
        border.color: field.activeFocus ? Theme.film(0.20) : Theme.film(0.10)

        Behavior on color {
            enabled: !Theme.reducedMotion
            ColorAnimation { duration: Theme.durMed }
        }

        Behavior on border.color {
            enabled: !Theme.reducedMotion
            ColorAnimation { duration: Theme.durMed }
        }

        // The prompt. summonghost.com puts a `$` in the ghost's amber ahead of
        // its install line for the same reason: it says, before anything is
        // typed, that this is a place you say things to a machine. `❯` rather
        // than `$` because what follows is addressed to the ghost, not to a
        // shell — Ghost has its own prefixes for those.
        Text {
            id: promptGlyph

            anchors.left: parent.left
            anchors.top: parent.top
            anchors.leftMargin: Theme.controlPaddingX
            anchors.topMargin: Theme.pad / 2
            text: "❯"
            color: field.enabled ? Theme.ghostAmber : Theme.foregroundFaint
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            font.weight: Font.Bold
        }

        // Dictation: Omarchy's Voxtype types into whatever has the keyboard,
        // so the button hands focus straight back to the field after toggling
        // it. Hidden entirely when Voxtype is not running.
        Item {
            id: micButton

            anchors.right: parent.right
            anchors.top: parent.top
            anchors.rightMargin: Theme.controlPaddingX
            anchors.topMargin: Theme.pad / 2
            width: Theme.charWidth * 2
            height: Theme.fontSize * 1.4
            visible: Dictation.available
            activeFocusOnTab: true

            Accessible.role: Accessible.Button
            Accessible.name: Dictation.recording ? "Stop dictation" : "Start dictation"

            Rectangle {
                id: micDot
                anchors.centerIn: parent
                width: Theme.fontSize * 0.6
                height: width
                radius: width / 2
                color: Dictation.recording ? Theme.ghostAmber
                    : (Dictation.state === "transcribing" ? Theme.foregroundDim : "transparent")
                border.width: Dictation.recording ? 0 : 1
                border.color: micArea.containsMouse ? Theme.ghostAmber : Theme.foregroundFaint

                SequentialAnimation on opacity {
                    running: Dictation.recording && !Theme.reducedMotion
                    loops: Animation.Infinite
                    NumberAnimation { to: 0.35; duration: 600 }
                    NumberAnimation { to: 1; duration: 600 }
                    onRunningChanged: if (!running) micDot.opacity = 1
                }
            }

            MouseArea {
                id: micArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: {
                    Dictation.toggle();
                    field.forceActiveFocus();
                }
            }

            Keys.onPressed: event => {
                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                        || event.key === Qt.Key_Space) {
                    Dictation.toggle();
                    field.forceActiveFocus();
                    event.accepted = true;
                }
            }
        }

        Flickable {
            id: scroller

            anchors.fill: parent
            anchors.margins: Theme.pad / 2
            // One column of air after the prompt, the way a shell leaves one.
            anchors.leftMargin: promptGlyph.anchors.leftMargin
                + promptGlyph.implicitWidth + Theme.charWidth
            anchors.rightMargin: Theme.pad / 2
                + (micButton.visible ? micButton.width + Theme.charWidth : 0)
            contentWidth: width
            contentHeight: field.implicitHeight
            clip: true
            interactive: contentHeight > height

            // Once the field is as tall as it gets, the caret has to stay in
            // view: typing past the bottom scrolls, and deleting lines never
            // leaves a blank band where text used to be.
            function keepCursorVisible(): void {
                const rect = field.cursorRectangle;
                if (rect.y < scroller.contentY) scroller.contentY = rect.y;
                else if (rect.y + rect.height > scroller.contentY + scroller.height)
                    scroller.contentY = rect.y + rect.height - scroller.height;
            }
            onContentHeightChanged: {
                scroller.contentY = Math.max(0, Math.min(scroller.contentY,
                    scroller.contentHeight - scroller.height));
                scroller.keepCursorVisible();
            }
            onHeightChanged: scroller.keepCursorVisible()

            TextEdit {
                id: field

                width: parent.width
                focus: true
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                wrapMode: TextEdit.Wrap
                selectByMouse: true
                selectionColor: Theme.selection
                selectedTextColor: Theme.foregroundBright

                onCursorRectangleChanged: scroller.keepCursorVisible()

                // A block the width of one column, not a hairline between two.
                // Qt gives the delegate the cursor's height and position; the
                // width is ours, and in a fixed-width face there is exactly one
                // right answer for it.
                cursorDelegate: Rectangle {
                    width: Theme.charWidth
                    color: Theme.ghostAmber
                    opacity: 0.75

                    SequentialAnimation on opacity {
                        running: field.activeFocus && !Theme.reducedMotion
                        loops: Animation.Infinite
                        NumberAnimation { to: 0; duration: 530 }
                        NumberAnimation { to: 0.75; duration: 530 }
                    }
                }

                Keys.onPressed: event => {
                    const enter = event.key === Qt.Key_Return || event.key === Qt.Key_Enter;
                    if (enter && !(event.modifiers & Qt.ShiftModifier)) {
                        root.submitted(field.text);
                        field.text = "";
                        event.accepted = true;
                    }
                }

                // The hint sits after the block caret, the way a shell prompt
                // leaves the cursor cell to the cursor.
                Text {
                    anchors.fill: parent
                    anchors.leftMargin: field.activeFocus ? Theme.charWidth : 0
                    visible: field.text === ""
                    text: Ghostd.activeGhost === ""
                        ? "No ghost selected"
                        : (Dictation.label !== "" ? Dictation.label
                        : Ghostd.streaming
                            ? "Follow up with " + Ghostd.activeGhost + "…"
                            : "Message " + Ghostd.activeGhost + "…")
                    color: Dictation.recording ? Theme.ghostAmber : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    elide: Text.ElideRight
                }
            }
        }
    }
}
