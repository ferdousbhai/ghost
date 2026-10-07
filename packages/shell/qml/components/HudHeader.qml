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
            text: (Ghostd.currentHarness === "" ? "harness: " + Ghostd.draftHarness
                : "via " + Ghostd.currentHarness + (Ghostd.currentModel !== "" ? "  " + Ghostd.currentModel : "")) + " ▾"
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
            visible: Ghostd.working
            text: "Esc to stop"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }
    }

    // The harness picker: a list of harnesses, where a name runs this
    // conversation's next turn on it, and one footer line saying what new
    // conversations start on, with the way to change that and the way back.
    Rectangle {
        id: picker
        objectName: "harnessPicker"

        readonly property var choice: Ghostd.harnessChoice
        readonly property string ghostDefault: picker.choice && picker.choice.ghostDefault
            ? picker.choice.ghostDefault : ""

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

            Text {
                height: implicitHeight + 4
                text: "RUN THIS CONVERSATION ON"
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
                font.letterSpacing: 0.5
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
                    id: harnessRow

                    required property var modelData
                    readonly property bool current: harnessRow.modelData.id === Ghostd.currentHarness

                    width: pickerColumn.width
                    height: Theme.controlHeight
                    color: chooseArea.containsMouse && harnessRow.modelData.eligible ? Theme.film(0.07) : "transparent"

                    MouseArea {
                        id: chooseArea
                        objectName: "harnessChoose-" + harnessRow.modelData.id
                        anchors.fill: parent
                        enabled: harnessRow.modelData.eligible
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.choose(harnessRow.modelData.id)
                    }

                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: 4
                        anchors.right: parent.right
                        anchors.rightMargin: 4
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: Theme.gap

                        Text {
                            id: harnessName
                            text: (harnessRow.current ? "• " : "  ") + harnessRow.modelData.id
                            color: !harnessRow.modelData.eligible ? Theme.foregroundFaint
                                : (harnessRow.current ? Theme.ghostAmberBright : Theme.foreground)
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }

                        Text {
                            width: Math.max(0, parent.width - harnessName.implicitWidth - Theme.gap)
                            visible: !harnessRow.modelData.eligible && harnessRow.modelData.reason !== ""
                            text: harnessRow.modelData.reason
                            elide: Text.ElideRight
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeCaption
                            anchors.verticalCenter: parent.verticalCenter
                        }
                    }
                }
            }

            // What a new conversation starts on: the ghost's own default, else
            // Omarchy's. "use <current>" makes this conversation's harness the
            // default; "automatic" hands the choice back to Omarchy.
            Item {
                visible: picker.choice !== null
                width: pickerColumn.width
                height: Theme.controlHeight

                Rectangle {
                    anchors.top: parent.top
                    width: parent.width
                    height: 1
                    color: Theme.border
                }

                Text {
                    objectName: "harnessNewConversations"
                    anchors.left: parent.left
                    anchors.leftMargin: 4
                    anchors.right: defaultActions.left
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    elide: Text.ElideRight
                    text: "new chats: " + (picker.ghostDefault !== "" ? picker.ghostDefault
                        : "automatic" + (picker.choice && picker.choice.omarchyDefault
                            ? " (" + picker.choice.omarchyDefault + ")" : ""))
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                }

                Row {
                    id: defaultActions
                    anchors.right: parent.right
                    anchors.rightMargin: 4
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.gap

                    PickerAction {
                        objectName: "harnessMakeDefault"
                        visible: Ghostd.currentHarness !== "" && Ghostd.currentHarness !== picker.ghostDefault
                        text: "use " + Ghostd.currentHarness
                        onActivated: Ghostd.setGhostHarness(Ghostd.currentHarness)
                    }

                    PickerAction {
                        objectName: "harnessAutomatic"
                        visible: picker.ghostDefault !== ""
                        text: "automatic"
                        onActivated: Ghostd.setGhostHarness(null)
                    }
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

    /** A small text link in the picker footer. */
    component PickerAction: Text {
        id: action

        signal activated()

        color: actionArea.containsMouse ? Theme.foreground : Theme.ghostAmber
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeCaption

        MouseArea {
            id: actionArea
            anchors.fill: parent
            anchors.margins: -4
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: action.activated()
        }
    }
}
