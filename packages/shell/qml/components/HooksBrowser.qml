pragma ComponentBehavior: Bound

// Owner-visible lifecycle-hook status. The daemon returns safe names,
// descriptions, triggers, and timing. Commands, paths, arguments, and injected
// context never cross into this surface.
import QtQuick
import qs.services
import "../services/HookStatus.js" as HookStatus

Rectangle {
    id: root

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    Component.onCompleted: Ghostd.fetchHooks(false)
    onVisibleChanged: if (root.visible) Ghostd.fetchHooks(false)

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
                    text: "Hooks"
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize + 3
                    font.weight: Font.DemiBold
                }

                Text {
                    width: parent.width
                    text: Ghostd.activeHookCount === 0
                        ? "No lifecycle hooks are active."
                        : Ghostd.activeHookCount + (Ghostd.activeHookCount === 1
                            ? " lifecycle hook is active."
                            : " lifecycle hooks are active.")
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            Rectangle {
                id: refreshButton
                width: refreshLabel.implicitWidth + Theme.pad * 1.5
                height: Theme.controlHeight
                radius: Theme.radius
                color: refreshArea.containsMouse ? Theme.film(0.08) : Theme.film(0.04)
                border.width: activeFocus ? 1 : 0
                border.color: Theme.amber(0.55)
                activeFocusOnTab: true
                enabled: !Ghostd.hooksLoading

                Accessible.role: Accessible.Button
                Accessible.name: "Refresh hooks"

                Text {
                    id: refreshLabel
                    anchors.centerIn: parent
                    text: Ghostd.hooksLoading ? "Refreshing" : "Refresh"
                    color: refreshButton.enabled ? Theme.foreground : Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                MouseArea {
                    id: refreshArea
                    anchors.fill: parent
                    enabled: refreshButton.enabled
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: Ghostd.fetchHooks(true)
                }

                Keys.onPressed: event => {
                    if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                            || event.key === Qt.Key_Space) && refreshButton.enabled) {
                        Ghostd.fetchHooks(true);
                        event.accepted = true;
                    }
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
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: headerRule.bottom
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: Math.max(height, catalog.implicitHeight + Theme.pad * 2)
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: catalog
            x: Theme.pad
            y: Theme.pad
            width: parent.width - Theme.pad * 2
            spacing: Theme.gap

            Rectangle {
                width: parent.width
                height: hookError.implicitHeight + Theme.pad
                visible: Ghostd.hooksError !== ""
                radius: Theme.radius
                color: Theme.rose(0.08)
                border.width: 1
                border.color: Theme.rose(0.18)

                Text {
                    id: hookError
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad / 2
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad / 2
                    anchors.verticalCenter: parent.verticalCenter
                    text: Ghostd.hooksError
                    color: Theme.danger
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            Repeater {
                model: Ghostd.activeHooks

                Rectangle {
                    id: hookCard
                    required property var modelData
                    width: catalog.width
                    height: eventColumn.implicitHeight + Theme.pad * 1.5
                    radius: Theme.radius
                    color: Theme.film(0.04)
                    border.width: 1
                    border.color: Theme.border

                    Column {
                        id: eventColumn
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.pad
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.pad
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: Theme.gap / 3

                        Text {
                            width: parent.width
                            text: hookCard.modelData.name
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            font.weight: Font.DemiBold
                        }

                        Text {
                            width: parent.width
                            text: hookCard.modelData.description
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }

                        Text {
                            width: parent.width
                            text: HookStatus.trigger(hookCard.modelData.event,
                                Ghostd.hookContinuationCap,
                                hookCard.modelData.idleSeconds)
                            color: Theme.ghostAmber
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall - 1
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }

            Text {
                width: parent.width
                visible: !Ghostd.hooksLoading && Ghostd.hooksError === ""
                    && Ghostd.activeHookCount === 0
                text: "Configure hooks in the daemon's trusted hooks file, then restart ghostd."
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                wrapMode: Text.WordWrap
                horizontalAlignment: Text.AlignHCenter
            }

            Text {
                width: parent.width
                visible: Ghostd.activeHookCount > 0
                text: "Only safe labels, triggers, and timing are shown. Hook commands and context stay private."
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
            }
        }
    }
}
