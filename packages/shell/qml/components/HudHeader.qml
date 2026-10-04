pragma ComponentBehavior: Bound

import QtQuick
import "../services"

// The HUD's top line: who is present, which agent CLI answers the open
// conversation (and the picker that changes it), and how to stop a running turn.
Item {
    id: root

    /** The harness picker is up. */
    property bool pickerOpen: false

    /** The picker closed; the keyboard has nowhere to be. */
    signal refocused()

    implicitHeight: 32

    function togglePicker(): void {
        if (root.pickerOpen) {
            root.closePicker();
            return;
        }
        root.pickerOpen = true;
        Ghostd.fetchHarnesses();
        picker.forceActiveFocus();
    }

    function closePicker(): void {
        if (!root.pickerOpen) return;
        root.pickerOpen = false;
        root.refocused();
    }

    /** Run the open conversation's next turn on `harness`, and get out of the way. */
    function choose(harness: string): void {
        Ghostd.chooseHarness(harness);
        root.closePicker();
    }

    // The choices belong to one ghost's conversation; a switch or a hidden
    // HUD drops them.
    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            root.closePicker();
        }

        function onCurrentSessionIdChanged(): void {
            root.closePicker();
        }

        function onHudVisibleChanged(): void {
            if (!Ghostd.hudVisible) root.closePicker();
        }
    }

    Row {
        anchors.left: parent.left
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.gap

        // Presence, not a status LED: the mascot itself carries reachability.
        // Amber and haloed when the daemon answers, bare danger-red when it
        // does not.
        Item {
            anchors.verticalCenter: parent.verticalCenter
            implicitWidth: 16
            implicitHeight: 16

            Glow {
                anchors.centerIn: parent
                width: 16 * 2.2
                visible: Ghostd.reachable
                core: Theme.amber(0.25)
                mid: Theme.amber(0.08)
                midAt: 0.55
            }

            GhostGlyph {
                anchors.centerIn: parent
                size: 16
                tint: Ghostd.reachable ? Theme.ghostAmber : Theme.danger
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
            color: Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSubtitle
            font.weight: Font.DemiBold
        }
    }

    Row {
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.pad

        // The harness the open conversation runs on, and the way to change it.
        // Quiet text until clicked; the picker below holds the choices.
        Text {
            id: harnessLabel
            objectName: "harnessLabel"
            anchors.verticalCenter: parent.verticalCenter
            visible: Ghostd.activeGhost !== ""
            text: (Ghostd.currentHarness !== "" ? "via " + Ghostd.currentHarness : "harness: automatic") + " ▾"
            color: harnessArea.containsMouse || root.pickerOpen ? Theme.foreground : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            Accessible.role: Accessible.Button
            Accessible.name: "Choose harness"

            MouseArea {
                id: harnessArea
                anchors.fill: parent
                hoverEnabled: true
                cursorShape: Qt.PointingHandCursor
                onClicked: root.togglePicker()
            }
        }

        Text {
            anchors.verticalCenter: parent.verticalCenter
            visible: Ghostd.streaming
            text: "Esc to stop"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }
    }

    // The harness picker. Each row's name picks the harness for this
    // conversation's next turn; its "default" toggles the ghost's own default,
    // and "automatic" clears that back to Omarchy's machine default.
    Rectangle {
        id: picker
        objectName: "harnessPicker"

        readonly property var choice: Ghostd.harnessChoice

        visible: root.pickerOpen
        focus: root.pickerOpen
        anchors.top: parent.bottom
        anchors.right: parent.right
        width: Math.min(Theme.ch(48), root.width)
        height: pickerColumn.implicitHeight + Theme.gap * 2
        radius: Theme.radius
        color: Theme.surface
        border.width: 1
        border.color: Theme.border

        Keys.onEscapePressed: event => {
            event.accepted = true;
            root.closePicker();
        }

        // Clicks inside the card are the card's business.
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
        }

        Column {
            id: pickerColumn
            x: Theme.gap
            y: Theme.gap
            width: picker.width - Theme.gap * 2
            spacing: 2

            Item {
                width: pickerColumn.width
                height: captionText.implicitHeight + 4

                Text {
                    id: captionText
                    text: "NEXT TURN RUNS ON"
                    color: Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                    font.letterSpacing: 0.5
                }

                Text {
                    anchors.right: parent.right
                    text: "GHOST DEFAULT"
                    color: Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                    font.letterSpacing: 0.5
                }
            }

            Text {
                visible: picker.choice === null && Ghostd.harnessError === ""
                text: "loading…"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Repeater {
                model: picker.choice ? picker.choice.harnesses : []

                delegate: Rectangle {
                    id: agentRow

                    required property var modelData
                    readonly property bool current: agentRow.modelData.id === Ghostd.currentHarness
                    readonly property bool isDefault: picker.choice !== null
                        && picker.choice.ghostDefault === agentRow.modelData.id

                    objectName: "harnessRow-" + agentRow.modelData.id
                    width: pickerColumn.width
                    height: Theme.controlHeight
                    color: chooseArea.containsMouse && agentRow.modelData.eligible ? Theme.film(0.07) : "transparent"

                    MouseArea {
                        id: chooseArea
                        objectName: "harnessChoose-" + agentRow.modelData.id
                        anchors.left: parent.left
                        anchors.right: defaultToggle.left
                        anchors.top: parent.top
                        anchors.bottom: parent.bottom
                        enabled: agentRow.modelData.eligible
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.choose(agentRow.modelData.id)
                    }

                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: 4
                        anchors.right: defaultToggle.left
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: Theme.gap

                        Text {
                            id: agentName
                            text: (agentRow.current ? "• " : "  ") + agentRow.modelData.id
                            color: !agentRow.modelData.eligible ? Theme.foregroundFaint
                                : (agentRow.current ? Theme.ghostAmberBright : Theme.foreground)
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }

                        Text {
                            width: Math.max(0, parent.width - agentName.implicitWidth - Theme.gap)
                            visible: !agentRow.modelData.eligible && agentRow.modelData.reason !== ""
                            text: agentRow.modelData.reason
                            elide: Text.ElideRight
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeCaption
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }

                    Text {
                        id: defaultToggle
                        anchors.right: parent.right
                        anchors.rightMargin: 4
                        anchors.verticalCenter: parent.verticalCenter
                        text: agentRow.isDefault ? "✓ default" : "default"
                        color: agentRow.isDefault ? Theme.ghostAmberBright
                            : (defaultArea.containsMouse ? Theme.foreground : Theme.foregroundFaint)
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeCaption

                        MouseArea {
                            id: defaultArea
                            objectName: "harnessDefault-" + agentRow.modelData.id
                            anchors.fill: parent
                            anchors.margins: -4
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Ghostd.setGhostHarness(agentRow.isDefault ? null : agentRow.modelData.id)
                        }
                    }
                }
            }

            // No ghost default: the daemon falls to Omarchy's machine default.
            Rectangle {
                id: automaticRow
                objectName: "harnessAutomatic"

                readonly property bool isDefault: picker.choice !== null && picker.choice.ghostDefault === null

                visible: picker.choice !== null
                width: pickerColumn.width
                height: Theme.controlHeight
                color: automaticArea.containsMouse ? Theme.film(0.07) : "transparent"

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: 4
                    anchors.right: automaticMark.left
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    elide: Text.ElideRight
                    text: "  automatic" + (picker.choice && picker.choice.omarchyDefault
                        ? "  omarchy: " + picker.choice.omarchyDefault : "")
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                Text {
                    id: automaticMark
                    anchors.right: parent.right
                    anchors.rightMargin: 4
                    anchors.verticalCenter: parent.verticalCenter
                    text: automaticRow.isDefault ? "✓ default" : "default"
                    color: automaticRow.isDefault ? Theme.ghostAmberBright
                        : (automaticArea.containsMouse ? Theme.foreground : Theme.foregroundFaint)
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                }

                MouseArea {
                    id: automaticArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: if (!automaticRow.isDefault) Ghostd.setGhostHarness(null)
                }
            }

            Text {
                objectName: "harnessError"
                visible: Ghostd.harnessError !== ""
                width: pickerColumn.width
                text: Ghostd.harnessError
                wrapMode: Text.Wrap
                color: Theme.danger
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
            }
        }
    }
}
