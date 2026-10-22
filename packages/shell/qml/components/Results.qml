pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Layouts
import QtQuick.Dialogs
import "../services"

Rectangle {
    id: root
    color: Theme.background
    property string downloadId: ""
    property string downloadGhost: ""
    property string downloadSession: ""
    function refresh(): void { Ghostd.sharedResults = []; Ghostd.resultsError = ""; Ghostd.resultsStatus = ""; Ghostd.refreshResults(); }
    onVisibleChanged: if (visible) root.refresh()
    Connections {
        target: Ghostd
        function onActiveGhostChanged(): void { if (root.visible) root.refresh(); }
        function onCurrentSessionIdChanged(): void { if (root.visible) root.refresh(); }
    }
    Timer { interval: 5000; running: root.visible; repeat: true; onTriggered: Ghostd.refreshResults() }
    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap
        RowLayout {
            Layout.fillWidth: true
            Text { text: "Shared results"; color: Theme.foreground; Layout.fillWidth: true }
            ActionButton { label: "Refresh"; enabled: !Ghostd.resultsBusy; onClicked: Ghostd.refreshResults() }
        }
        Text {
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: Ghostd.resultsError || Ghostd.resultsStatus || "Share a finished file in this conversation. Each shared copy can be downloaded or moved to Trash."
            color: Ghostd.resultsError ? Theme.danger : Theme.foregroundDim
            wrapMode: Text.Wrap
        }
        RowLayout {
            Layout.fillWidth: true
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: source.implicitHeight + Theme.gap * 2
                color: Theme.background
                border.color: source.activeFocus ? Theme.foregroundDim : Theme.border
                radius: Theme.controlRadius
                TextInput {
                    id: source
                    anchors.fill: parent
                    anchors.margins: Theme.gap
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize
                    selectByMouse: true
                    selectionColor: Theme.selection
                    clip: true
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        visible: source.text === ""
                        text: "Full path of the file to share"
                        color: Theme.foregroundDim
                        font: source.font
                    }
                }
            }
            ActionButton {
                label: "Share file"
                enabled: !Ghostd.resultsBusy && source.text.startsWith("/") && Ghostd.currentSessionId !== ""
                onClicked: Ghostd.changeResult("POST", "", { path: source.text })
            }
        }
        Text { text: Ghostd.currentSessionId === "" ? "Select a conversation first." : (Ghostd.sharedResults.length ? "" : "No files shared yet."); color: Theme.foregroundDim }
        ListView {
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: Theme.gap
            model: Ghostd.sharedResults
            delegate: RowLayout {
                id: row
                required property var modelData
                width: ListView.view.width
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: row.modelData.name + " · " + row.modelData.bytes + " bytes"
                    color: Theme.foreground
                    wrapMode: Text.WrapAnywhere
                }
                ActionButton {
                    label: "Save as…"
                    enabled: !Ghostd.resultsBusy
                    onClicked: { root.downloadId = row.modelData.id; root.downloadGhost = Ghostd.activeGhost; root.downloadSession = Ghostd.currentSessionId; destination.open(); }
                }
                ActionButton {
                    label: "Remove"
                    danger: true
                    enabled: !Ghostd.resultsBusy
                    onClicked: Ghostd.changeResult("DELETE", "/" + encodeURIComponent(row.modelData.id), null)
                }
            }
        }
    }
    FileDialog {
        id: destination
        title: "Save shared result"
        fileMode: FileDialog.SaveFile
        onAccepted: Ghostd.downloadResult(root.downloadId, decodeURIComponent(selectedFile.toString().replace(/^file:\/\//, "")), root.downloadGhost, root.downloadSession)
    }
}
