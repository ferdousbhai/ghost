pragma ComponentBehavior: Bound

// The input field. Enter sends, Shift+Enter opens a new line, Esc bubbles up
// to the HUD so a half-typed prompt is never a reason you can't dismiss.
//
// Plain TextEdit rather than QtQuick.Controls TextArea: Controls would pull in
// a style whose colours would compete with the shared neutral design tokens.
import QtQuick
import Qt5Compat.GraphicalEffects
import qs.services
import "CommandCatalog.js" as CommandCatalog

Item {
    id: root

    signal submitted(string text, string mode)

    property alias text: field.text
    property bool slashDismissed: false
    property int slashIndex: 0

    onTextChanged: Ghostd.composerHasDraft = root.text.trim() !== ""

    readonly property bool slashIntent: field.text.startsWith("/")
        && !/\s/u.test(field.text)
    readonly property var slashMatches: root.slashIntent
        ? CommandCatalog.completions(Ghostd.commands, field.text, 6) : []
    readonly property bool slashOpen: !root.slashDismissed && field.activeFocus
        && root.slashIntent && root.slashMatches.length > 0
    readonly property bool slashPanelOpen: !root.slashDismissed && field.activeFocus
        && root.slashIntent && (Ghostd.commandsLoading || root.slashMatches.length > 0)

    implicitHeight: Math.min(Math.max(field.implicitHeight + Theme.pad, 48), 160)

    function take(): void {
        field.forceActiveFocus();
    }

    /**
     * Put a command at the front without losing an existing draft. A previous
     * slash token is replaced; ordinary draft text becomes the command's
     * arguments. The trailing space is intentional and mirrors OMP's palette.
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
            text: "Discovering OMP commands…"
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

        Flickable {
            anchors.fill: parent
            anchors.margins: Theme.pad / 2
            contentWidth: width
            contentHeight: field.implicitHeight
            clip: true
            interactive: contentHeight > height

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

                Text {
                    anchors.fill: parent
                    visible: field.text === ""
                    text: Ghostd.activeGhost === ""
                        ? "No ghost selected"
                        : (Ghostd.streaming
                            ? "Steer " + Ghostd.activeGhost + "…  ·  Ctrl+Enter follows up"
                            : "Message " + Ghostd.activeGhost + "…")
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    elide: Text.ElideRight
                }
            }
        }
    }
}
