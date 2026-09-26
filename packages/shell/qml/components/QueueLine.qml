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

    // One lane of queued messages: its label, then one elided chip per message.
    component Lane: Flow {
        id: lane

        required property string label
        required property var items
        required property color labelColor
        required property color fill
        required property color edge
        required property color ink

        visible: lane.items.length > 0
        Layout.fillWidth: true
        spacing: Theme.gap / 2

        Text {
            text: lane.label
            color: lane.labelColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        Repeater {
            model: lane.items
            delegate: Rectangle {
                id: chip
                required property string modelData
                implicitWidth: Math.min(chipText.implicitWidth + Theme.gap, lane.width * 0.72)
                implicitHeight: 22
                radius: Theme.bubbleRadiusSmall
                color: lane.fill
                border.width: 1
                border.color: lane.edge

                Text {
                    id: chipText
                    anchors.fill: parent
                    anchors.margins: Theme.gap / 2
                    text: chip.modelData
                    color: lane.ink
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    elide: Text.ElideRight
                }
            }
        }
    }

    Lane {
        label: "Steering →"
        items: root.steering
        labelColor: Theme.ghostAmber
        fill: Theme.amber(0.12)
        edge: Theme.amber(0.20)
        ink: Theme.foregroundBright
    }

    Lane {
        label: "Then →"
        items: root.followUps
        labelColor: Theme.amber(0.70)
        fill: Theme.film(0.05)
        edge: Theme.film(0.10)
        ink: Theme.foreground
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
