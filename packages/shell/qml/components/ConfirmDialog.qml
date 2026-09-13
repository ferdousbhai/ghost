pragma ComponentBehavior: Bound

// A modal confirmation: scrim over the whole HUD, one card in the middle of it,
// two buttons. For destructive actions whose second click deserves a real
// question rather than an armed row — the ×-turns-into-"Delete" trick reads as
// a stutter in the list and puts the answer under the pointer that just asked.
//
// Owned by whoever opens it (the HUD), not by the row that asked: a dialog
// anchored inside a scrolling sidebar would scroll with it. The caller drives
// `open`, `busy` and `error`; this only renders them and reports the answer.
import QtQuick
import "../services"

Item {
    id: root

    /** Shown when true. The owner sets it back to false on `dismissed`, and
        keeps it true through a slow confirm so `busy` has somewhere to show. */
    property bool open: false
    property string title: ""
    property string body: ""
    property string confirmText: "Delete"
    property string cancelText: "Cancel"
    property bool busy: false
    /** The failure to show in place of nothing happening, or "". */
    property string error: ""
    property bool destructive: true
    /** When set, the confirm stays locked until this exact string is typed
        back — the gate an erased home directory earns over a stray Return. */
    property string challenge: ""
    property string challengePlaceholder: ""

    readonly property bool answered: root.challenge === ""
        || challengeField.text === root.challenge

    signal confirmed()
    signal dismissed()

    // Kept alive through the fade-out, then out of the input chain entirely.
    visible: root.opacity > 0
    opacity: root.open ? 1 : 0
    z: 100

    Behavior on opacity {
        enabled: !Theme.reducedMotion
        NumberAnimation { duration: Theme.durFast }
    }

    function accept(): void {
        if (root.busy || !root.answered) return;
        root.confirmed();
    }

    function reject(): void {
        if (root.busy) return;
        root.dismissed();
    }

    // The dialog owns the keyboard while it is up; the composer gets focus back
    // from the owner once it closes. A challenge takes the caret itself — the
    // answer is the next thing to type.
    onOpenChanged: {
        if (!root.open) return;
        challengeField.text = "";
        if (root.challenge !== "") challengeField.forceActiveFocus();
        else root.forceActiveFocus();
    }

    focus: root.open
    Keys.onEscapePressed: event => {
        event.accepted = true;
        root.reject();
    }
    Keys.onReturnPressed: event => {
        event.accepted = true;
        root.accept();
    }
    Keys.onEnterPressed: event => {
        event.accepted = true;
        root.accept();
    }

    // Scrim: dims what is behind, swallows every click that is not the card,
    // and dismisses on a click outside — the usual escape hatch.
    Rectangle {
        anchors.fill: parent
        color: Qt.rgba(0, 0, 0, Theme.light ? 0.28 : 0.55)

        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
            onClicked: root.reject()
        }
    }

    Rectangle {
        id: dialog

        anchors.centerIn: parent
        width: Math.min(root.width - Theme.pad * 4, 380)
        height: content.implicitHeight + Theme.pad * 2
        radius: Theme.radius
        color: Theme.surface
        border.width: 1
        border.color: Theme.border
        scale: root.open ? 1 : 0.96

        Behavior on scale {
            enabled: !Theme.reducedMotion
            NumberAnimation { duration: Theme.durFast; easing.type: Easing.OutCubic }
        }

        // Clicks on the card are the card's business, not the scrim's.
        MouseArea {
            anchors.fill: parent
            hoverEnabled: true
        }

        Column {
            id: content

            x: Theme.pad
            y: Theme.pad
            width: parent.width - Theme.pad * 2
            spacing: Theme.gap

            Text {
                width: parent.width
                text: root.title
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                font.weight: Font.DemiBold
                wrapMode: Text.Wrap
            }

            Text {
                width: parent.width
                visible: root.body !== ""
                text: root.body
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.Wrap
                lineHeight: Theme.lineHeight
            }

            // Type-the-name gate. Plain TextInput, not a Controls TextField:
            // the shell themes itself from Omarchy and will not carry a style
            // stack for one field.
            Rectangle {
                width: parent.width
                height: Theme.controlHeight - Theme.gap
                visible: root.challenge !== ""
                radius: Theme.radius / 2
                color: Theme.film(0.06)
                border.width: 1
                border.color: root.answered ? Theme.rose(0.50) : Theme.film(0.10)

                Behavior on border.color {
                    enabled: !Theme.reducedMotion
                    ColorAnimation { duration: Theme.durFast }
                }

                TextInput {
                    id: challengeField
                    anchors.fill: parent
                    anchors.leftMargin: Theme.gap / 2
                    anchors.rightMargin: Theme.gap / 2
                    verticalAlignment: TextInput.AlignVCenter
                    enabled: !root.busy
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    selectByMouse: true
                    selectionColor: Theme.selection
                    clip: true
                    onAccepted: root.accept()
                    Keys.onEscapePressed: event => {
                        event.accepted = true;
                        root.reject();
                    }

                    Text {
                        anchors.left: parent.left
                        anchors.verticalCenter: parent.verticalCenter
                        visible: challengeField.text === ""
                        text: root.challengePlaceholder
                        color: Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }
                }
            }

            // The daemon's own words when the confirm fails (a conversation
            // still streaming, a busy ghost), so the dialog stays up with the
            // reason instead of closing on a no-op.
            Text {
                width: parent.width
                visible: root.error !== ""
                text: root.error
                color: Theme.danger
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.Wrap
            }

            Item {
                width: parent.width
                height: Theme.controlHeight - Theme.gap / 2

                Row {
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: Theme.gap

                    Rectangle {
                        width: Math.max(72, cancelLabel.implicitWidth + Theme.pad)
                        height: Theme.controlHeight - Theme.gap
                        radius: Theme.radius / 2
                        color: cancelArea.containsMouse ? Theme.film(0.10) : Theme.film(0.06)
                        opacity: root.busy ? 0.5 : 1

                        Behavior on color {
                            enabled: !Theme.reducedMotion
                            ColorAnimation { duration: Theme.durFast }
                        }

                        Text {
                            id: cancelLabel
                            anchors.centerIn: parent
                            text: root.cancelText
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }

                        MouseArea {
                            id: cancelArea
                            anchors.fill: parent
                            enabled: !root.busy
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.reject()
                        }
                    }

                    Rectangle {
                        width: Math.max(72, confirmLabel.implicitWidth + Theme.pad)
                        height: Theme.controlHeight - Theme.gap
                        radius: Theme.radius / 2
                        opacity: root.answered ? 1 : 0.45
                        color: root.destructive
                            ? (confirmArea.containsMouse && !root.busy && root.answered
                                ? Theme.rose(0.26) : Theme.rose(0.14))
                            : (confirmArea.containsMouse && !root.busy && root.answered
                                ? Theme.film(0.16) : Theme.film(0.10))
                        border.width: 1
                        border.color: root.destructive ? Theme.rose(0.40) : Theme.film(0.14)

                        Behavior on opacity {
                            enabled: !Theme.reducedMotion
                            NumberAnimation { duration: Theme.durFast }
                        }

                        Behavior on color {
                            enabled: !Theme.reducedMotion
                            ColorAnimation { duration: Theme.durFast }
                        }

                        Text {
                            id: confirmLabel
                            anchors.centerIn: parent
                            text: root.busy ? "…" : root.confirmText
                            color: root.destructive ? Theme.ghostRose : Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            font.weight: Font.DemiBold
                        }

                        MouseArea {
                            id: confirmArea
                            anchors.fill: parent
                            enabled: !root.busy && root.answered
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.accept()
                        }
                    }
                }
            }
        }
    }
}
