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
    signal newConversationRequested()

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
        anchors.rightMargin: micButton.visible ? micButton.width + Theme.gap : 0
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

        Item {
            id: composeButton
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            anchors.leftMargin: Theme.pad / 2
            width: Theme.controlHeight
            height: Theme.controlHeight
            visible: Ghostd.activeGhost !== ""
            activeFocusOnTab: true
            Accessible.role: Accessible.Button
            Accessible.name: "New conversation"

            Text {
                anchors.centerIn: parent
                text: "+"
                color: composeArea.containsMouse ? Theme.ghostAmberBright : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeHeading
            }

            MouseArea {
                id: composeArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.newConversationRequested()
            }

            Keys.onPressed: event => {
                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                        || event.key === Qt.Key_Space) {
                    root.newConversationRequested();
                    event.accepted = true;
                }
            }
        }

        Flickable {
            id: scroller

            anchors.fill: parent
            anchors.margins: Theme.pad / 2
            anchors.leftMargin: composeButton.visible
                ? composeButton.width + Theme.pad : Theme.pad
            anchors.rightMargin: Theme.pad
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

    // Voxtype types into the focused field, so return focus after toggling.
    Rectangle {
        id: micButton
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        width: Theme.controlHeight + Theme.pad
        height: width
        radius: width / 2
        visible: Dictation.available
        color: Dictation.recording ? Theme.ghostAmber : Theme.film(0.10)
        border.width: 1
        border.color: Dictation.recording ? Theme.ghostAmberBright : Theme.film(0.20)
        activeFocusOnTab: true
        Accessible.role: Accessible.Button
        Accessible.name: Dictation.recording ? "Stop dictation" : "Start dictation"

        GhostGlyph {
            anchors.centerIn: parent
            size: Theme.fontSize + 4
            path: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"
            tint: Dictation.recording ? Theme.background :
                (micArea.containsMouse ? Theme.ghostAmberBright : Theme.foregroundBright)
        }

        SequentialAnimation on opacity {
            running: Dictation.recording && !Theme.reducedMotion
            loops: Animation.Infinite
            NumberAnimation { to: 0.55; duration: 600 }
            NumberAnimation { to: 1; duration: 600 }
            onRunningChanged: if (!running) micButton.opacity = 1
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
}
