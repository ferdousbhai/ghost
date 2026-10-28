// PresencePrompt — the pill a summon opens: type, or just talk.
//
// Voxtype is already listening when it opens and types into it, since it
// holds the keyboard. Enter sends what is written; with nothing written yet,
// Enter while listening stops the recording and sends what Voxtype types.
// Tab moves to the next ghost of a fresh conversation; Esc, or a click
// outside, closes the prompt and discards the recording.
import QtQuick
import "../services"

Rectangle {
    id: root

    property bool active: false

    width: Math.min(Theme.ch(72), parent ? parent.width - Theme.pad * 2 : Theme.ch(72))
    height: column.implicitHeight + Theme.pad * 2
    radius: Theme.radius
    color: Theme.background
    border.width: 1
    border.color: Dictation.recording ? Theme.amber(0.7) : Theme.film(0.22)

    onActiveChanged: if (root.active) root.begin()
    Component.onCompleted: if (root.active) root.begin()

    function begin(): void {
        field.text = "";
        Qt.callLater(() => field.forceActiveFocus());
    }

    function nextGhost(): void {
        const names = Ghostd.ghosts.map(g => g.name);
        if (Presence.continuing || names.length < 2) return;
        Ghostd.selectGhost(names[(names.indexOf(Ghostd.activeGhost) + 1) % names.length]);
    }

    // How to leave, in sight; Super+W does the same while Ghost holds the keyboard.
    Text {
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: parent.top
        anchors.topMargin: Theme.pad
        text: "esc to close"
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeCaption
        z: 1
    }

    // Swallow clicks so the screen behind does not read one as "dismiss".
    MouseArea { anchors.fill: parent; onClicked: field.forceActiveFocus() }

    Column {
        id: column
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        anchors.leftMargin: Theme.pad
        anchors.rightMargin: Theme.pad
        spacing: Theme.gap

        Row {
            spacing: Theme.gap

            SpectralOrb {
                anchors.verticalCenter: parent.verticalCenter
                diameter: Theme.fontSize + 6
                turnKey: "presence"
                // Motion means the ghost is working; at rest the orb holds still.
                running: Ghostd.anyStreaming
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Presence.continuing
                    ? Ghostd.activeGhost + " · continuing"
                    : Ghostd.activeGhost + (Ghostd.ghosts.length > 1 ? "  ⇥" : "")
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
            }

            // The way back to a fresh conversation from a follow-up.
            Text {
                anchors.verticalCenter: parent.verticalCenter
                visible: Presence.continuing
                text: "new ×"
                color: freshArea.containsMouse ? Theme.foregroundBright : Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption

                MouseArea {
                    id: freshArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: Presence.startFresh()
                }
            }
        }

        Item {
            width: parent.width
            height: Math.max(field.implicitHeight, Theme.controlHeight)

            TextEdit {
                id: field
                objectName: "presenceField"
                anchors.fill: parent
                anchors.rightMargin: Dictation.available ? Theme.controlHeight + Theme.gap : 0
                wrapMode: TextEdit.Wrap
                color: Theme.foregroundBright
                selectionColor: Theme.selection
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSubtitle
                verticalAlignment: TextEdit.AlignVCenter

                onTextChanged: if (Presence.sendAfterDictation) sendTimer.restart()

                Keys.onPressed: event => {
                    if (event.key === Qt.Key_Escape) {
                        Presence.dismiss();
                        event.accepted = true;
                    } else if (event.key === Qt.Key_Tab) {
                        root.nextGhost();
                        event.accepted = true;
                    } else if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                            && !(event.modifiers & Qt.ShiftModifier)) {
                        if (field.text.trim() !== "") {
                            Presence.send(field.text);
                        } else if (Dictation.recording) {
                            Presence.sendAfterDictation = true;
                            Dictation.toggle();
                        }
                        event.accepted = true;
                    }
                }

                Text {
                    anchors.fill: parent
                    visible: field.text === ""
                    verticalAlignment: Text.AlignVCenter
                    text: Presence.sendAfterDictation ? "Transcribing…"
                        : Dictation.recording ? "Listening… or type"
                        : "Ask " + Ghostd.activeGhost + "…"
                    color: Dictation.recording ? Theme.ghostAmber : Theme.foregroundDim
                    font: field.font
                }
            }

            // The listening light: amber while Voxtype records; a click toggles it.
            Rectangle {
                id: listening
                anchors.right: parent.right
                anchors.verticalCenter: parent.verticalCenter
                visible: Dictation.available
                width: Theme.controlHeight
                height: width
                radius: width / 2
                color: Dictation.recording ? Theme.ghostAmber : Theme.film(0.10)

                SequentialAnimation on opacity {
                    running: Dictation.recording
                    loops: Animation.Infinite
                    onRunningChanged: if (!running) listening.opacity = 1
                    NumberAnimation { to: 0.55; duration: 700; easing.type: Easing.InOutSine }
                    NumberAnimation { to: 1; duration: 700; easing.type: Easing.InOutSine }
                }

                GhostGlyph {
                    anchors.centerIn: parent
                    size: Theme.fontSize + 2
                    path: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM19 10v2a7 7 0 0 1-14 0v-2M12 19v3M8 22h8"
                    tint: Dictation.recording ? Theme.background : Theme.foregroundBright
                }

                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: {
                        field.forceActiveFocus();
                        Dictation.toggle();
                    }
                }
            }
        }

        Text {
            width: parent.width
            visible: Dictation.failure !== ""
            text: Dictation.failure
            color: Theme.ghostRose
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeCaption
            wrapMode: Text.Wrap
        }
    }

    // Voxtype types a transcript a few characters at a time; send once it
    // has gone quiet after the recording stopped.
    Timer {
        id: sendTimer
        interval: 700
        onTriggered: Presence.dictationSettled(field.text)
    }

    Connections {
        target: Dictation
        function onStateChanged(): void {
            if (Presence.sendAfterDictation && Dictation.state === "idle") sendTimer.restart();
        }
    }
}
