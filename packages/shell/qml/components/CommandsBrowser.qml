pragma ComponentBehavior: Bound

// The effective slash-command catalog for the active conversation. Discovery
// stays daemon-side because extensions, plugins, skills, and file commands
// all participate in precedence there. Choosing one only stages it in chat;
// Enter remains the explicit act that runs it.
import QtQuick
import "../services"
import "CommandCatalog.js" as CommandCatalog

Rectangle {
    id: root

    signal commandPicked(string invocation)

    property alias searchText: searchInput.text
    readonly property var groups: CommandCatalog.groups(Ghostd.commands, root.searchText)
    readonly property int resultCount: root.groups.reduce(function (count, group) {
        return count + group.commands.length;
    }, 0)

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function textOf(value: var): string {
        return value === undefined || value === null ? "" : String(value);
    }

    function aliasesText(command: var): string {
        const aliases = CommandCatalog.aliases(command);
        return aliases.length === 0 ? "" : aliases.map(function (alias) {
            return "/" + alias;
        }).join("  ·  ");
    }

    function detailText(command: var): string {
        const parts = [];
        const input = CommandCatalog.inputHint(command ? command.input : null);
        const subcommands = CommandCatalog.subcommandText(command);
        if (input !== "") parts.push("Input  " + input);
        if (subcommands !== "") parts.push("Subcommands  " + subcommands);
        const reason = CommandCatalog.unavailableReason(command);
        if (reason !== "") parts.push(reason);
        return parts.join("    ");
    }

    function stage(command: var): void {
        const invocation = CommandCatalog.invocation(command);
        if (invocation !== "") root.commandPicked(invocation);
    }

    Component.onCompleted: if (Ghostd.activeGhost !== "") Ghostd.fetchCommands(false)
    onVisibleChanged: if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchCommands(false)

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            root.searchText = "";
            if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchCommands(false);
        }

        function onCurrentSessionIdChanged(): void {
            if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchCommands(false);
        }
    }

    Column {
        id: header

        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: parent.top
        anchors.topMargin: Theme.pad
        spacing: Theme.gap

        Row {
            width: parent.width
            spacing: Theme.gap

            Column {
                width: parent.width - refreshButton.width - Theme.gap
                spacing: Theme.gap / 3

                Text {
                    width: parent.width
                    text: "Commands"
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeHeading
                    font.weight: Font.DemiBold
                }

                Text {
                    width: parent.width
                    text: "Commands available in this conversation. Choose one to stage it in chat."
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            ActionButton {
                id: refreshButton

                label: Ghostd.commandsLoading ? "Refreshing" : "Refresh"
                enabled: Ghostd.activeGhost !== "" && !Ghostd.commandsLoading
                Accessible.name: "Refresh commands"
                onClicked: Ghostd.fetchCommands(true)
            }
        }

        Rectangle {
            width: parent.width
            height: Theme.controlHeight
            radius: Theme.radius
            color: Theme.film(0.05)
            border.width: searchInput.activeFocus ? 1 : 0
            border.color: Theme.amber(0.50)

            TextInput {
                id: searchInput
                anchors.fill: parent
                anchors.leftMargin: Theme.pad
                anchors.rightMargin: Theme.pad
                verticalAlignment: TextInput.AlignVCenter
                color: Theme.foregroundBright
                selectionColor: Theme.selection
                selectedTextColor: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                clip: true
                activeFocusOnTab: true

                Accessible.name: "Search commands"

                Text {
                    anchors.fill: parent
                    verticalAlignment: Text.AlignVCenter
                    visible: searchInput.text === ""
                    text: "Search names, aliases, descriptions, and sources"
                    color: Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    elide: Text.ElideRight
                }
            }
        }
    }

    Rectangle {
        id: headerRule
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Theme.pad
        height: 1
        color: Theme.border
    }

    Flickable {
        id: catalogScroll

        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: headerRule.bottom
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: Math.max(height, catalog.implicitHeight + Theme.pad * 2)
        clip: true
        interactive: contentHeight > height
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: catalog
            x: Theme.pad
            y: Theme.pad
            width: catalogScroll.width - Theme.pad * 2
            spacing: Theme.sectionGap

            Text {
                width: parent.width
                visible: Ghostd.commandsNotice !== ""
                text: Ghostd.commandsNotice
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
            }

            Rectangle {
                width: parent.width
                height: errorText.implicitHeight + Theme.pad
                visible: Ghostd.commandsError !== ""
                radius: Theme.radius
                color: Theme.rose(0.08)
                border.width: 1
                border.color: Theme.rose(0.18)

                Text {
                    id: errorText
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad / 2
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad / 2
                    anchors.verticalCenter: parent.verticalCenter
                    text: Ghostd.commandsError
                    color: Theme.danger
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            Column {
                width: parent.width
                visible: Ghostd.commandsLoading && Ghostd.commands.length === 0
                spacing: Theme.gap / 2

                Text {
                    width: parent.width
                    text: "Discovering commands…"
                    color: Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSubtitle
                    font.weight: Font.DemiBold
                    horizontalAlignment: Text.AlignHCenter
                }

                Text {
                    width: parent.width
                    text: "Reading this conversation's commands, prompts, and skills."
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                }
            }

            Column {
                width: parent.width
                visible: !Ghostd.commandsLoading && Ghostd.commandsError === ""
                    && Ghostd.commandsNotice === "" && root.resultCount === 0
                spacing: Theme.gap / 2

                Text {
                    width: parent.width
                    text: root.searchText.trim() === "" ? "No commands available" : "No matching commands"
                    color: Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSubtitle
                    font.weight: Font.DemiBold
                    horizontalAlignment: Text.AlignHCenter
                }

                Text {
                    width: parent.width
                    text: root.searchText.trim() === ""
                        ? "Add commands, prompts, or skills to this ghost and refresh."
                        : "Try a command name, alias, description, or source."
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                }
            }

            Repeater {
                model: root.groups

                Column {
                    id: commandGroup

                    required property var modelData
                    width: catalog.width
                    spacing: Theme.gap

                    Row {
                        width: parent.width
                        spacing: Theme.gap

                        Text {
                            text: commandGroup.modelData.label
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeCaption
                            font.weight: Font.DemiBold
                            font.capitalization: Font.AllUppercase
                            font.letterSpacing: 1
                        }

                        Rectangle {
                            anchors.verticalCenter: parent.verticalCenter
                            width: parent.width - parent.children[0].width - Theme.gap
                            height: 1
                            color: Theme.border
                        }
                    }

                    Repeater {
                        model: commandGroup.modelData.commands

                        Rectangle {
                            id: commandRow

                            required property var modelData
                            width: commandGroup.width
                            height: commandCopy.implicitHeight + Theme.pad
                            radius: Theme.radius
                            color: commandArea.containsMouse ? Theme.amber(0.09) : Theme.film(0.035)
                            border.width: activeFocus ? 1 : 0
                            border.color: Theme.amber(0.55)
                            activeFocusOnTab: true

                            Accessible.role: Accessible.Button
                            Accessible.name: "/" + CommandCatalog.commandName(commandRow.modelData)
                            Accessible.description: root.textOf(commandRow.modelData.description)

                            Behavior on color {
                                enabled: !Theme.reducedMotion
                                ColorAnimation { duration: Theme.durFast }
                            }

                            Column {
                                id: commandCopy
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.pad / 2
                                anchors.right: stageMark.left
                                anchors.rightMargin: Theme.gap
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: Theme.gap / 3

                                Row {
                                    width: parent.width
                                    spacing: Theme.gap

                                    Text {
                                        id: commandNameLabel
                                        text: "/" + CommandCatalog.commandName(commandRow.modelData)
                                        color: Theme.ghostAmberBright
                                        font.family: Theme.fontFamilyMono
                                        font.pixelSize: Theme.fontSize
                                        font.weight: Font.DemiBold
                                    }

                                    Text {
                                        width: parent.width - commandNameLabel.width
                                            - availabilityBadge.width - parent.spacing * 2
                                        visible: text !== ""
                                        text: root.aliasesText(commandRow.modelData)
                                        color: Theme.foregroundFaint
                                        font.family: Theme.fontFamilyMono
                                        font.pixelSize: Theme.fontSizeSmall
                                        elide: Text.ElideRight
                                    }

                                    Rectangle {
                                        id: availabilityBadge
                                        visible: CommandCatalog.availability(commandRow.modelData)
                                            !== "supported"
                                        width: visible ? availabilityText.implicitWidth + Theme.gap : 0
                                        implicitHeight: availabilityText.implicitHeight + 4
                                        radius: Theme.radius / 2
                                        color: CommandCatalog.availability(commandRow.modelData)
                                            === "unsupported" ? Theme.rose(0.12) : Theme.amber(0.12)
                                        border.width: 1
                                        border.color: CommandCatalog.availability(commandRow.modelData)
                                            === "unsupported" ? Theme.rose(0.25) : Theme.amber(0.25)
                                        Text {
                                            id: availabilityText
                                            anchors.centerIn: parent
                                            text: CommandCatalog.availabilityLabel(commandRow.modelData)
                                            color: CommandCatalog.availability(commandRow.modelData)
                                                === "unsupported" ? Theme.danger : Theme.warn
                                            font.family: Theme.fontFamily
                                            font.pixelSize: Theme.fontSizeCaption
                                            font.weight: Font.DemiBold
                                        }
                                    }
                                }

                                Text {
                                    width: parent.width
                                    visible: text !== ""
                                    text: root.textOf(commandRow.modelData.description)
                                    color: Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    wrapMode: Text.WordWrap
                                }

                                Text {
                                    width: parent.width
                                    visible: text !== ""
                                    text: root.detailText(commandRow.modelData)
                                    color: Theme.foregroundFaint
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSizeCaption
                                    wrapMode: Text.WordWrap
                                }
                            }

                            Text {
                                id: stageMark
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.pad / 2
                                anchors.verticalCenter: parent.verticalCenter
                                text: "→"
                                color: commandArea.containsMouse ? Theme.ghostAmberBright : Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeTitle
                            }

                            MouseArea {
                                id: commandArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.stage(commandRow.modelData)
                            }

                            Keys.onPressed: event => {
                                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space) {
                                    root.stage(commandRow.modelData);
                                    event.accepted = true;
                                }
                            }
                        }
                    }
                }
            }

            Text {
                width: parent.width
                visible: root.resultCount > 0
                text: root.resultCount + (root.resultCount === 1 ? " command" : " commands")
                    + "  ·  selecting one never runs it"
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
                horizontalAlignment: Text.AlignHCenter
            }
        }
    }
}
