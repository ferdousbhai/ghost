pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import "../services"

Rectangle {
    id: root
    signal closeRequested()
    color: Theme.background
    clip: true
    onVisibleChanged: if (visible) Ghostd.refreshRoutines()
    Component.onCompleted: if (visible) Ghostd.refreshRoutines()
    Keys.onEscapePressed: root.closeRequested()
    Connections {
        target: Ghostd
        function onActiveGhostChanged(): void { if (root.visible) Ghostd.refreshRoutines(); }
    }
    Timer {
        interval: 10000
        running: root.visible
        repeat: true
        onTriggered: Ghostd.refreshRoutines()
    }
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap
        RowLayout {
            Layout.fillWidth: true
            Text {
                Layout.fillWidth: true
                text: "Routines · " + Ghostd.activeGhost
                color: Theme.foreground
                font.pixelSize: Theme.fontSize
            }
            ActionButton {
                label: Ghostd.routinesLoading ? "Refreshing…" : "Refresh"
                enabled: !Ghostd.routinesLoading
                onClicked: Ghostd.refreshRoutines()
            }
        }
        Text {
            Layout.fillWidth: true
            text: Ghostd.routinesError || "Systemd timers. Pause stops future triggers; running work continues. Resume may catch up."
            color: Ghostd.routinesError ? Theme.danger : Theme.foregroundDim
            wrapMode: Text.Wrap
            font.pixelSize: Theme.fontSizeSmall
        }
        Text {
            visible: !Ghostd.routinesLoading && Ghostd.routines.length === 0 && !Ghostd.routinesError
            text: "No routines. Ask your ghost to schedule work, or see ghost help timers."
            color: Theme.foregroundDim
            Layout.fillWidth: true
            wrapMode: Text.Wrap
        }
        ListView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: Theme.gap
            model: Ghostd.routinesGhost === Ghostd.activeGhost ? Ghostd.routines : []
            delegate: Rectangle {
                id: card
                required property var modelData
                required property int index
                width: ListView.view.width
                height: content.implicitHeight + Theme.pad * 2
                color: Qt.alpha(Theme.foreground, 0.04)
                radius: Theme.controlRadius
                ColumnLayout {
                    id: content
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.top: parent.top
                    anchors.margins: Theme.pad
                    spacing: Theme.gap
                    Text {
                        Layout.fillWidth: true
                        text: card.modelData.slug + " · " + (card.modelData.enabled || "unknown") + " · " + (card.modelData.active || "unknown")
                        color: Theme.foreground
                        wrapMode: Text.Wrap
                    }
                    Text {
                        Layout.fillWidth: true
                        text: (card.modelData.schedule || "Schedule unavailable")
                            + "\nNext: " + (card.modelData.nextRun || "unknown")
                            + "\nLast run: " + (card.modelData.lastRun || "never/unknown")
                            + "\nService: " + (card.modelData.serviceActive || "unknown") + " · Result: " + (card.modelData.result || "unknown")
                            + "\n" + card.modelData.command
                            + "\nLogs: journalctl --user -u " + card.modelData.service
                        color: Theme.foregroundDim
                        wrapMode: Text.WrapAnywhere
                        font.pixelSize: Theme.fontSizeSmall
                    }
                    RowLayout {
                        ActionButton {
                            label: "Pause"
                            enabled: !Ghostd.routinesLoading
                            onClicked: Ghostd.controlRoutine(card.modelData.slug, "pause")
                        }
                        ActionButton {
                            label: "Resume"
                            enabled: !Ghostd.routinesLoading
                            onClicked: Ghostd.controlRoutine(card.modelData.slug, "resume")
                        }
                        ActionButton {
                            label: "Run now"
                            enabled: !Ghostd.routinesLoading
                            onClicked: Ghostd.controlRoutine(card.modelData.slug, "run")
                        }
                    }
                    RowLayout {
                        ActionButton {
                            label: "Open timer"
                            onClicked: Workbench.open(card.modelData.timerPath)
                        }
                        ActionButton {
                            label: "Open service"
                            enabled: card.modelData.servicePath !== ""
                            onClicked: Workbench.open(card.modelData.servicePath)
                        }
                    }
                }
            }
        }
    }
}
