pragma ComponentBehavior: Bound

// What the ghost will hear next: steering lands in the running turn, follow-ups
// wait for it to end. Amber marks the live one; the queued ones stay on film.
import QtQuick
import QtQuick.Layouts
import "../services"

ColumnLayout {
    id: root

    property var steering: []
    property var followUps: []
    property string error: ""

    visible: steering.length > 0 || followUps.length > 0 || error !== ""
    spacing: Theme.gap / 2

    Flow {
        visible: root.steering.length > 0
        Layout.fillWidth: true
        spacing: Theme.gap / 2

        Text {
            text: "Steering →"
            color: Theme.ghostAmber
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        Repeater {
            model: root.steering
            delegate: Rectangle {
                id: steerChip
                required property string modelData
                implicitWidth: Math.min(steerText.implicitWidth + Theme.gap, root.width * 0.72)
                implicitHeight: 22
                radius: Theme.radius
                color: Theme.amber(0.12)
                border.width: 1
                border.color: Theme.amber(0.20)

                Text {
                    id: steerText
                    anchors.fill: parent
                    anchors.margins: Theme.gap / 2
                    text: steerChip.modelData
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    elide: Text.ElideRight
                }
            }
        }
    }

    Flow {
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
                id: followChip
                required property string modelData
                implicitWidth: Math.min(followText.implicitWidth + Theme.gap, root.width * 0.72)
                implicitHeight: 22
                radius: Theme.radius
                color: Theme.film(0.05)
                border.width: 1
                border.color: Theme.film(0.10)

                Text {
                    id: followText
                    anchors.fill: parent
                    anchors.margins: Theme.gap / 2
                    text: followChip.modelData
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
