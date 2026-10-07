pragma ComponentBehavior: Bound

// The input field. Enter sends (or queues a follow-up while the ghost is
// working), Shift+Enter opens a new line, Esc bubbles up to the HUD so a
// half-typed prompt is never a reason you can't dismiss. An image pasted or
// dropped here rides along: it shows in the tray above the field until it is
// sent or taken off, and Send names it in the message (see Attachments.js).
//
// Plain TextEdit rather than QtQuick.Controls TextArea: Controls would pull in
// a style whose colours would compete with the shared neutral design tokens.
import QtQuick
import Quickshell
import Quickshell.Io
import Qt5Compat.GraphicalEffects
import "../services"
import "../services/Attachments.js" as Attachments

Item {
    id: root

    signal submitted(string text)
    signal newConversationRequested()

    property alias text: field.text

    /** The tallest the field grows before it scrolls; the HUD sets it from its height. */
    property int maxHeight: 160

    readonly property int trayHeight: tray.visible ? tray.height + Theme.gap / 2 : 0

    implicitHeight: Math.min(Math.max(field.implicitHeight + Theme.pad, 48), root.maxHeight) + root.trayHeight

    function take(): void {
        field.forceActiveFocus();
    }

    /** Text ghostd handed back (a stop's queue, a refused follow-up), above what is typed since. */
    function restore(text: string): void {
        field.text = field.text.trim() === "" ? text : text + "\n\n" + field.text;
        root.take();
    }

    /** Send the draft with whatever images are attached; nothing while one is still uploading. */
    function submit(): void {
        if (Ghostd.attachmentsBusy) return;
        root.submitted(Attachments.compose(field.text, Ghostd.takeAttachments()));
        field.text = "";
    }

    // Wayland's clipboard is read by running wl-paste. The probe picks the
    // first image type on offer and writes it under XDG_RUNTIME_DIR, printing
    // the file it wrote; a clipboard with no image exits quietly, and the
    // field's own paste has already handled any text.
    Process {
        id: pasteProbe

        property string target: ""

        command: ["sh", "-c",
            "t=$(wl-paste --list-types 2>/dev/null | grep -m1 -E '^image/(png|jpeg|webp|gif)$') || exit 0; "
            + "e=${t#image/}; [ \"$e\" = jpeg ] && e=jpg; "
            + "wl-paste --no-newline --type \"$t\" > \"$1.$e\" && printf '%s\\n' \"$1.$e\"",
            "sh", pasteProbe.target]
        stdout: SplitParser {
            onRead: data => {
                const path = data.trim();
                if (path !== "") Ghostd.attach(path, true);
            }
        }
    }

    function pasteImage(): void {
        const runtime = Quickshell.env("XDG_RUNTIME_DIR") || "";
        if (runtime === "" || pasteProbe.running || Ghostd.activeGhost === "") return;
        pasteProbe.target = runtime + "/ghost-paste-" + Date.now().toString(36);
        pasteProbe.running = true;
    }

    DropArea {
        anchors.fill: parent
        onEntered: drag => drag.accepted = drag.hasUrls
        onDropped: drop => {
            for (const url of drop.urls) {
                const text = String(url);
                if (!text.startsWith("file://")) continue;
                Ghostd.attach(decodeURIComponent(text.slice("file://".length)), false);
            }
            field.forceActiveFocus();
        }
    }

    // The tray, a chat app's preview strip: one picture per attached image,
    // dimmed while it uploads, rose-edged if the daemon refused it, each with
    // its own way off.
    Row {
        id: tray

        anchors.left: parent.left
        anchors.top: parent.top
        spacing: Theme.gap / 2
        visible: Ghostd.attachments.length > 0
        height: 96

        Repeater {
            model: Ghostd.attachments

            delegate: Rectangle {
                id: chip

                required property var modelData

                width: tray.height
                height: tray.height
                radius: Theme.bubbleTailRadius
                color: Theme.film(0.05)
                border.width: 1
                border.color: chip.modelData.error !== "" ? Theme.rose(0.60) : Theme.film(0.15)
                clip: true

                Accessible.role: Accessible.Graphic
                Accessible.name: chip.modelData.error !== "" ? chip.modelData.error : "Attached image"

                Image {
                    anchors.fill: parent
                    anchors.margins: 1
                    // The daemon's copy once it holds one: a pasted file is
                    // removed as soon as it is uploaded.
                    source: chip.modelData.path !== "" && Workbench.home !== ""
                        ? "file://" + Workbench.home + "/sessions/" + chip.modelData.sessionId
                            + "/" + chip.modelData.path
                        : chip.modelData.local
                    sourceSize.width: tray.height * 2
                    sourceSize.height: tray.height * 2
                    fillMode: Image.PreserveAspectCrop
                    asynchronous: true
                    opacity: chip.modelData.path === "" && chip.modelData.error === "" ? 0.45 : 1
                }

                Rectangle {
                    anchors.top: parent.top
                    anchors.right: parent.right
                    anchors.margins: 2
                    width: 16
                    height: 16
                    radius: 8
                    color: removeArea.containsMouse ? Theme.rose(0.85) : Qt.rgba(0, 0, 0, 0.55)

                    Text {
                        anchors.centerIn: parent
                        text: "×"
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    MouseArea {
                        id: removeArea
                        anchors.fill: parent
                        anchors.margins: -4
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        Accessible.role: Accessible.Button
                        Accessible.name: "Remove image"
                        onClicked: Ghostd.detach(chip.modelData.id)
                    }
                }
            }
        }
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
        anchors.topMargin: root.trayHeight
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
                        root.submit();
                        event.accepted = true;
                    } else if (event.matches(StandardKey.Paste)) {
                        // Left unaccepted so the field still pastes any text.
                        root.pasteImage();
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
                        : Ghostd.working
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
        anchors.verticalCenter: surface.verticalCenter
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
