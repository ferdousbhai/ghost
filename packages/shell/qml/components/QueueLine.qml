pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts
import qs.services

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
            color: Theme.accent
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
                radius: Theme.radius / 2
                color: Theme.selection

                Text {
                    id: steerText
                    anchors.fill: parent
                    anchors.margins: Theme.gap / 2
                    text: steerChip.modelData
                    color: Theme.foreground
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
            color: Theme.warn
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
                radius: Theme.radius / 2
                color: Theme.surfaceDeep
                border.width: 0
                border.color: Theme.border

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
        color: Theme.danger
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeSmall
        wrapMode: Text.Wrap
    }
}
