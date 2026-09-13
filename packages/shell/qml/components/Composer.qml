pragma ComponentBehavior: Bound

// The input field. Enter sends, Shift+Enter opens a new line, Esc bubbles up
// to the HUD so a half-typed prompt is never a reason you can't dismiss.
//
// Plain TextEdit rather than QtQuick.Controls TextArea: Controls would pull in
// a style whose colours would compete with the shared neutral design tokens.
import QtQuick
import Qt5Compat.GraphicalEffects
import "../services"
import "CommandCatalog.js" as CommandCatalog

Item {
    id: root

    signal submitted(string text, string mode)

    property alias text: field.text
    property bool slashDismissed: false
    property int slashIndex: 0

    readonly property bool hasDraft: field.text.trim() !== ""
    readonly property bool slashIntent: field.text.startsWith("/")
        && !/\s/u.test(field.text)
    readonly property var slashMatches: root.slashIntent
        ? CommandCatalog.completions(Ghostd.commands, field.text, 6) : []
    readonly property bool slashOpen: !root.slashDismissed && field.activeFocus
        && root.slashIntent && root.slashMatches.length > 0
    readonly property bool slashPanelOpen: !root.slashDismissed && field.activeFocus
        && root.slashIntent && (Ghostd.commandsLoading || root.slashMatches.length > 0)

    /** The tallest the field grows before it scrolls; the HUD sets it from its height. */
    property int maxHeight: 160

    implicitHeight: Math.min(Math.max(field.implicitHeight + Theme.pad, 48), root.maxHeight)

    function take(): void {
        field.forceActiveFocus();
    }

    /**
     * Put a command at the front without losing an existing draft. A previous
     * slash token is replaced; ordinary draft text becomes the command's
     * arguments. The trailing space is intentional so arguments can follow.
     */
    function stageCommand(invocation: string): void {
        const prefix = String(invocation || "");
        if (prefix === "") return;
        const current = field.text;
        const command = /^\/\S+\s*/u.exec(current);
        field.text = prefix + (command ? current.slice(command[0].length) : current);
        field.cursorPosition = field.text.length;
        root.slashDismissed = true;
        field.forceActiveFocus();
    }

    function acceptSlash(index: int): void {
        const command = root.slashMatches[index];
        if (command) root.stageCommand(CommandCatalog.invocation(command));
    }

    onSlashIntentChanged: {
        root.slashDismissed = false;
        root.slashIndex = 0;
        if (root.slashIntent) Ghostd.fetchCommands(false);
    }

    onSlashMatchesChanged: {
        if (root.slashMatches.length === 0) root.slashIndex = 0;
        else if (root.slashIndex >= root.slashMatches.length)
            root.slashIndex = root.slashMatches.length - 1;
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
        id: slashPanel

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.bottom: surface.top
        anchors.bottomMargin: Theme.gap
        z: 20
        visible: root.slashPanelOpen
        height: Ghostd.commandsLoading && root.slashMatches.length === 0
            ? Theme.controlHeight + Theme.pad
            : slashOptions.implicitHeight + Theme.gap
        radius: Theme.radiusLarge
        color: Theme.surface
        border.width: 1
        border.color: Theme.border
        clip: true

        Text {
            anchors.centerIn: parent
            visible: Ghostd.commandsLoading && root.slashMatches.length === 0
            text: "Discovering commands…"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        Column {
            id: slashOptions
            anchors.left: parent.left
            anchors.leftMargin: Theme.gap / 2
            anchors.right: parent.right
            anchors.rightMargin: Theme.gap / 2
            anchors.verticalCenter: parent.verticalCenter
            visible: root.slashMatches.length > 0

            Repeater {
                model: root.slashMatches

                Rectangle {
                    id: slashOption

                    required property var modelData
                    required property int index
                    width: slashOptions.width
                    height: Theme.controlHeight
                    radius: Theme.radius
                    color: slashOption.index === root.slashIndex
                        ? Theme.amber(0.12)
                        : (slashArea.containsMouse ? Theme.film(0.06) : "transparent")

                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.gap
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: Theme.gap

                        Text {
                            text: "/" + CommandCatalog.commandName(slashOption.modelData)
                            color: slashOption.index === root.slashIndex
                                ? Theme.ghostAmberBright : Theme.foregroundBright
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            font.weight: Font.DemiBold
                        }

                        Text {
                            width: parent.width - parent.children[0].width - Theme.gap
                            text: {
                                const availability = CommandCatalog.availability(slashOption.modelData);
                                const reason = CommandCatalog.unavailableReason(slashOption.modelData);
                                const description = String(slashOption.modelData.description || "");
                                if (availability === "supported") return description;
                                const label = CommandCatalog.availabilityLabel(slashOption.modelData);
                                return label + (reason !== "" ? " — " + reason
                                    : (description !== "" ? " — " + description : ""));
                            }
                            color: CommandCatalog.availability(slashOption.modelData)
                                === "unsupported" ? Theme.danger : Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            elide: Text.ElideRight
                        }
                    }

                    MouseArea {
                        id: slashArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onEntered: root.slashIndex = slashOption.index
                        onClicked: root.acceptSlash(slashOption.index)
                    }
                }
            }
        }
    }

    Rectangle {
        id: surface

        anchors.fill: parent
        radius: Theme.radiusLarge
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
                }
                onVisibleChanged: if (!Dictation.recording) opacity = 1
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
                enabled: Ghostd.pendingAsk === null

                // A block the width of one column, not a hairline between two.
                // Qt gives the delegate the cursor's height and position; the
                // width is ours, and in a fixed-width face there is exactly one
                // right answer for it.
                onCursorRectangleChanged: scroller.keepCursorVisible()

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
                    if (root.slashOpen && (event.key === Qt.Key_Down
                            || event.key === Qt.Key_Up)) {
                        const delta = event.key === Qt.Key_Down ? 1 : -1;
                        root.slashIndex = (root.slashIndex + delta
                            + root.slashMatches.length) % root.slashMatches.length;
                        event.accepted = true;
                        return;
                    }
                    if (root.slashPanelOpen && event.key === Qt.Key_Escape) {
                        root.slashDismissed = true;
                        event.accepted = true;
                        return;
                    }
                    if (root.slashOpen && (enter || event.key === Qt.Key_Tab)) {
                        root.acceptSlash(root.slashIndex);
                        event.accepted = true;
                        return;
                    }
                    if (enter && !(event.modifiers & Qt.ShiftModifier)) {
                        const mode = Ghostd.streaming
                            ? ((event.modifiers & Qt.ControlModifier) ? "followUp" : "steer")
                            : "prompt";
                        root.submitted(field.text, mode);
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
                            ? "Steer " + Ghostd.activeGhost + "…  ·  Ctrl+Enter follows up"
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
