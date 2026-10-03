pragma ComponentBehavior: Bound

// What the ghost will hear next: follow-ups queued behind the running turn,
// each run after the current pass ends.
import QtQuick
import QtQuick.Layouts
import "../services"

ColumnLayout {
    id: root

    property var followUps: []
    property string error: ""

    visible: followUps.length > 0 || error !== ""
    spacing: Theme.gap / 2

    // Its label, then one elided chip per queued message.
    Flow {
        id: lane

        visible: root.followUps.length > 0
        Layout.fillWidth: true
        spacing: Theme.gap / 2

        Text {
            text: "Then →"
            color: Theme.amber(0.70)
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        Repeater {
            model: root.followUps
            delegate: Rectangle {
                id: chip
                required property string modelData
                implicitWidth: Math.min(chipText.implicitWidth + Theme.gap, lane.width * 0.72)
                implicitHeight: 22
                radius: Theme.bubbleRadiusSmall
                color: Theme.film(0.05)
                border.width: 1
                border.color: Theme.film(0.10)

                Text {
                    id: chipText
                    anchors.fill: parent
                    anchors.margins: Theme.gap / 2
                    text: chip.modelData
                    color: Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    elide: Text.ElideRight
                }
            }
        }
    }

    Text {
        visible: root.error !== ""
        Layout.fillWidth: true
        text: root.error
        color: Theme.ghostRose
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
        wrapMode: Text.Wrap
    }
}
