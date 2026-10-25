pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Controls
import "../services"

Rectangle {
    id: root
    signal closeRequested()
    property string editGhost: ""
    property string editSlug: ""
    property string editRevision: ""
    property string pendingRemove: ""
    property string pendingRevision: ""
    property string logGhost: ""
    property var logSessions: []
    function refresh(): void { Ghostd.refreshRoutines(); }
    readonly property var recoveries: Ghostd.routineRecoveries

    color: Theme.background
    clip: true
    onVisibleChanged: if (visible) root.refresh()
    Component.onCompleted: if (visible) root.refresh()
    Keys.onEscapePressed: root.closeRequested()
    Connections {
        target: Ghostd
        function onActiveGhostChanged(): void {
            root.pendingRemove = ""; removeDialog.open = false;
            if (root.visible) root.refresh();
        }
        function onRoutineConfigReady(ghost: string, slug: string, config: var): void {
            if (!root.visible) return;
            if (root.pendingRemove === slug) { root.pendingRevision = config.revision; removeDialog.open = true; return; }
            root.editGhost = ghost; root.editSlug = slug; root.editRevision = config.revision;
            timerSource.text = config.timer; serviceSource.text = config.service || "";
            editor.open();
        }
        function onRoutineLogsReady(ghost: string, logs: var): void {
            root.logGhost = ghost; root.logSessions = logs.sessions;
            journalText.text = (logs.truncated ? "Older log text truncated.\n" : "") + logs.text;
            journal.open();
        }
        function onRoutineMutationFinished(ok: bool): void {
            if (ok) { editor.close(); root.pendingRemove = ""; removeDialog.open = false; }
        }
    }
    Timer {
        interval: 10000
        running: root.visible
        repeat: true
        onTriggered: root.refresh()
    }
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap
        RowLayout {
            Layout.fillWidth: true
            Text {
                textFormat: Text.PlainText
                Layout.fillWidth: true
                text: "Routines · " + Ghostd.activeGhost
                color: Theme.foreground
                font.pixelSize: Theme.fontSize
            }
            ActionButton {
                label: Ghostd.routinesLoading ? "Refreshing…" : "Refresh"
                enabled: !Ghostd.routinesLoading
                onClicked: root.refresh()
            }
        }
        Text {
            textFormat: Text.PlainText
            Layout.fillWidth: true
            text: Ghostd.routineWriteError || Ghostd.routinesError || "Systemd timers. Pause stops future triggers; running work continues. Resume may catch up."
            color: (Ghostd.routineWriteError || Ghostd.routinesError) ? Theme.danger : Theme.foregroundDim
            wrapMode: Text.Wrap
            font.pixelSize: Theme.fontSizeSmall
        }
        Text {
            textFormat: Text.PlainText
            visible: !Ghostd.routinesLoading && Ghostd.routines.length === 0 && !Ghostd.routinesError
            text: "No routines. Ask your ghost to schedule work, or see ghost help timers."
            color: Theme.foregroundDim
            Layout.fillWidth: true
            wrapMode: Text.Wrap
        }
        ScrollView {
            Layout.fillWidth: true
            Layout.preferredHeight: Math.min(140, recoveryRows.implicitHeight)
            visible: root.recoveries.length > 0
            clip: true
            Column {
                id: recoveryRows
                width: parent.width
                Repeater {
                    model: root.recoveries
                    delegate: RowLayout {
                        id: recoveryRow
                        required property var modelData
                        width: recoveryRows.width
                        Text {
                            textFormat: Text.PlainText
                            Layout.fillWidth: true
                            text: recoveryRow.modelData.slug + " · " + recoveryRow.modelData.reason + " · " + recoveryRow.modelData.createdAt
                            color: Theme.foregroundDim
                            elide: Text.ElideMiddle
                        }
                        ActionButton {
                            label: recoveryRow.modelData.applicable ? "Restore paused" : "Source changed"
                            enabled: recoveryRow.modelData.applicable && !Ghostd.routinesLoading
                            onClicked: Ghostd.mutateRoutine(Ghostd.activeGhost, "recoveries/" + recoveryRow.modelData.id + "/restore", "POST", {})
                        }
                    }
                }
            }
        }
        ListView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: Theme.gap
            model: Ghostd.routines
            delegate: Rectangle {
                id: card
                required property var modelData
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
                        textFormat: Text.PlainText
                        Layout.fillWidth: true
                        text: card.modelData.slug + " · " + (card.modelData.enabled || "unknown") + " · " + (card.modelData.active || "unknown")
                        color: Theme.foreground
                        wrapMode: Text.Wrap
                    }
                    Text {
                        textFormat: Text.PlainText
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
                            onClicked: Ghostd.mutateRoutine(Ghostd.activeGhost, encodeURIComponent(card.modelData.slug) + "/pause", "POST", {})
                        }
                        ActionButton {
                            label: "Resume"
                            enabled: !Ghostd.routinesLoading
                            onClicked: Ghostd.mutateRoutine(Ghostd.activeGhost, encodeURIComponent(card.modelData.slug) + "/resume", "POST", {})
                        }
                        ActionButton {
                            label: "Run now"
                            enabled: !Ghostd.routinesLoading
                            onClicked: Ghostd.mutateRoutine(Ghostd.activeGhost, encodeURIComponent(card.modelData.slug) + "/run", "POST", {})
                        }
                    }
                    RowLayout {
                        ActionButton {
                            label: "Logs"
                            enabled: !Ghostd.routinesLoading
                            onClicked: Ghostd.fetchRoutineLogs(card.modelData.slug)
                        }
                        ActionButton {
                            objectName: "routineEdit"
                            label: "Edit sources"
                            enabled: !Ghostd.routinesLoading && root.editSlug === ""
                            onClicked: { root.pendingRemove = ""; Ghostd.fetchRoutineConfig(card.modelData.slug); }
                        }
                        ActionButton {
                            label: "Remove"
                            danger: true
                            enabled: !Ghostd.routinesLoading
                            onClicked: {
                                root.pendingRemove = card.modelData.slug;
                                Ghostd.fetchRoutineConfig(card.modelData.slug);
                            }
                        }
                    }
                }
            }
        }
    }
    ConfirmDialog {
        id: removeDialog
        anchors.fill: parent
        title: "Remove routine?"
        body: "Disable and remove “" + root.pendingRemove + "”? Running work continues. A recoverable checkpoint is kept."
        confirmText: "Remove"
        busy: Ghostd.routinesLoading
        error: Ghostd.routineWriteError
        onDismissed: { open = false; root.pendingRemove = ""; }
        onConfirmed: Ghostd.mutateRoutine(Ghostd.activeGhost, encodeURIComponent(root.pendingRemove) + "?revision=" + encodeURIComponent(root.pendingRevision), "DELETE", null)
    }
    Popup {
        id: editor
        objectName: "routineEditor"
        anchors.centerIn: parent
        width: Math.min(root.width - Theme.pad * 2, 900)
        height: root.height - Theme.pad * 2
        modal: true
        closePolicy: Popup.NoAutoClose
        onClosed: root.editSlug = ""
        background: Rectangle { color: Theme.background; border.color: Theme.border; radius: Theme.controlRadius }
        contentItem: ColumnLayout {
            spacing: Theme.gap
            Text { textFormat: Text.PlainText; text: "Edit " + root.editGhost + "/" + root.editSlug; color: Theme.foreground }
            Text {
                textFormat: Text.PlainText
                Layout.fillWidth: true
                text: Ghostd.routineWriteError || "Save verifies both units and reloads systemd. Previous sources remain recoverable."
                color: Ghostd.routineWriteError ? Theme.danger : Theme.foregroundDim
                wrapMode: Text.Wrap
            }
            Text { textFormat: Text.PlainText; text: "Timer unit"; color: Theme.foreground }
            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                TextArea { id: timerSource; objectName: "routineTimerSource"; readOnly: Ghostd.routineActionRequest !== null; color: Theme.foreground; font.family: Theme.fontFamily; wrapMode: TextEdit.Wrap }
            }
            Text { textFormat: Text.PlainText; text: "Service unit"; color: Theme.foreground }
            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                TextArea { id: serviceSource; readOnly: Ghostd.routineActionRequest !== null; color: Theme.foreground; font.family: Theme.fontFamily; wrapMode: TextEdit.Wrap }
            }
            RowLayout {
                ActionButton {
                    objectName: "routineSave"
                    label: "Save"
                    enabled: !Ghostd.routinesLoading && Ghostd.activeGhost === root.editGhost
                    onClicked: Ghostd.mutateRoutine(root.editGhost, encodeURIComponent(root.editSlug) + "/config", "PUT", { timer: timerSource.text, service: serviceSource.text, revision: root.editRevision })
                }
                ActionButton {
                    objectName: "routineDiscard"
                    label: "Discard draft"
                    enabled: !Ghostd.routinesLoading
                    onClicked: editor.close()
                }
            }
        }
    }

    Popup {
        id: journal
        anchors.centerIn: parent
        width: root.width - Theme.pad * 2
        height: root.height - Theme.pad * 2
        modal: true
        background: Rectangle { color: Theme.background; border.color: Theme.border }
        contentItem: ColumnLayout {
            Text { textFormat: Text.PlainText; text: "Routine journal"; color: Theme.foreground }
            ScrollView {
                Layout.fillWidth: true
                Layout.fillHeight: true
                TextArea { id: journalText; readOnly: true; color: Theme.foreground; wrapMode: TextEdit.WrapAnywhere }
            }
            Repeater {
                model: root.logSessions
                delegate: ActionButton {
                    required property string modelData
                    label: "Open " + modelData.slice(0, 18) + "…"
                    onClicked: { Ghostd.openConversationForGhost(root.logGhost, modelData); journal.close(); root.closeRequested(); }
                }
            }
            ActionButton { label: "Close"; onClicked: journal.close() }
        }
    }

}
