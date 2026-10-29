pragma ComponentBehavior: Bound

// The voice a ghost answers in when it is asked aloud (Speech). Each voice
// plays Piper's published sample before anything is downloaded; choosing one
// that is not installed downloads it (~60 MB) and gives it to this ghost, and
// choosing it again while it downloads cancels. An installed voice can be
// removed. "Silent" is the default, and every ghost's own choice.
import QtQuick
import "../services"
import "../services/SpeechVoices.js" as Voices

Column {
    id: root

    /** The ghost whose voice this is. */
    required property string ghost

    readonly property string chosen: Speech.voiceFor(root.ghost)

    spacing: Theme.gap

    Component.onCompleted: Speech.refresh()

    Text {
        text: "Voice"
        textFormat: Text.PlainText
        color: Theme.foregroundDim
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
    }

    Flow {
        width: parent.width
        spacing: Theme.gap

        Chip {
            objectName: "voice-silent"
            name: "Silent"
            detail: "no spoken replies"
            selected: root.chosen === ""
            onPicked: Speech.choose(root.ghost, "")
        }

        Repeater {
            model: Voices.offered(Speech.installed)

            delegate: Chip {
                id: offer
                required property var modelData
                objectName: "voice-" + offer.modelData.id
                name: offer.modelData.name
                detail: Speech.installing === offer.modelData.id ? "downloading…"
                    : offer.modelData.installed ? offer.modelData.detail : offer.modelData.detail + " · 60 MB"
                selected: root.chosen === offer.modelData.id
                sample: offer.modelData.sample ? offer.modelData.id : ""
                removable: offer.modelData.installed && Speech.installing === ""
                onPicked: offer.modelData.installed ? Speech.choose(root.ghost, offer.modelData.id)
                    : Speech.install(offer.modelData.id, root.ghost)
                onRemoved: Speech.remove(offer.modelData.id)
            }
        }
    }

    Text {
        width: parent.width
        textFormat: Text.PlainText
        wrapMode: Text.WordWrap
        text: Speech.installError !== "" ? Speech.installError
            : Speech.engine === "" ? "Spoken replies need Piper, which is not installed: yay -S piper-tts-bin. Samples play without it."
            : root.chosen === "" ? "Pick a voice and " + root.ghost + " reads its reply aloud when you ask aloud."
            : root.ghost + " reads the opening of its reply aloud when you ask aloud."
        color: Speech.installError !== "" ? Theme.danger : Theme.foregroundDim
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
    }

    component Chip: Rectangle {
        id: chip

        property string name
        property string detail
        property bool selected: false
        /** The voice whose sample ▶ plays, or "" for none. */
        property string sample: ""
        property bool removable: false

        signal picked()
        signal removed()

        width: content.implicitWidth + Theme.gap * 3
        height: content.implicitHeight + Theme.gap * 1.5
        radius: Theme.controlRadius
        color: chip.selected ? Theme.menuSelectedBackground : pickArea.containsMouse ? Theme.surface : "transparent"
        border.color: chip.selected ? Theme.menuSelectedBorder : Theme.border
        Accessible.role: Accessible.RadioButton
        Accessible.name: chip.name + ", " + chip.detail
        Accessible.checked: chip.selected

        MouseArea {
            id: pickArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: chip.picked()
        }

        Row {
            id: content
            anchors.centerIn: parent
            spacing: Theme.gap

            GlyphButton {
                anchors.verticalCenter: parent.verticalCenter
                visible: chip.sample !== ""
                text: Speech.previewing === chip.sample ? "■" : "▶"
                name: Speech.previewing === chip.sample ? "Stop the sample" : "Hear " + chip.name
                restColor: Theme.foregroundDim
                font.pixelSize: Theme.fontSizeSmall
                onClicked: Speech.preview(chip.sample)
            }

            Column {
                anchors.verticalCenter: parent.verticalCenter
                Text {
                    text: chip.name
                    textFormat: Text.PlainText
                    color: chip.selected ? Theme.menuSelectedText : Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                }
                Text {
                    text: chip.detail
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                }
            }

            GlyphButton {
                anchors.verticalCenter: parent.verticalCenter
                visible: chip.removable
                text: "×"
                name: "Remove " + chip.name
                restColor: Theme.foregroundFaint
                hoverColor: Theme.danger
                font.pixelSize: Theme.fontSizeSmall
                onClicked: chip.removed()
            }
        }
    }
}
