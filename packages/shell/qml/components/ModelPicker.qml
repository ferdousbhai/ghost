pragma ComponentBehavior: Bound

// ModelPicker — the model chip's pane: choose the active ghost's chat model
// from pi's live list of what its credentials reach, hand the choice back to
// pi's default, or connect another provider (ModelLogin, swapped in over the
// list). Choosing writes `roles.chat_model` through Ghostd.setChatModel.
import QtQuick
import QtQuick.Layouts
import "../services"

Rectangle {
    id: root

    signal closeRequested()

    property bool connecting: false
    readonly property string query: search.text.trim().toLowerCase()
    // The "Default" row leads the list whenever nothing is typed, so a binding
    // can be handed back even when no listed model is reachable.
    readonly property var rows: {
        const models = Ghostd.availableModels.filter(model => root.query === ""
            || (model.provider + "/" + model.id + " " + (model.name || "")).toLowerCase()
                .indexOf(root.query) >= 0);
        return root.query === "" ? [null].concat(models) : models;
    }

    radius: Theme.radius
    color: Theme.background

    Keys.onEscapePressed: root.closeRequested()

    Connections {
        target: Ghostd
        function onModelWritten(): void { root.closeRequested(); }
        // The list and the current model each arrive on their own; a ghost
        // switch under an open pane lists the new ghost's models.
        function onActiveGhostChanged(): void { if (root.visible) Ghostd.fetchAvailableModels(); }
        function onCurrentModelChanged(): void { root.resetHighlight(); }
        function onModelSourceChanged(): void { root.resetHighlight(); }
    }

    // Return picks the highlighted row, so the highlight starts where nothing
    // changes: on the current model with no query, on the best match with one.
    function resetHighlight(): void {
        modelList.currentIndex = root.query === ""
            ? root.rows.findIndex(row => root.isCurrent(row)) : 0;
    }

    function open(connect: bool): void {
        search.text = "";
        Ghostd.modelError = "";
        Ghostd.fetchAvailableModels();
        root.connecting = connect;
        if (connect) login.open();
        else Qt.callLater(search.focusInput);
    }

    function connectProvider(): void {
        root.connecting = true;
        login.open();
    }

    function isCurrent(model: var): bool {
        const current = Ghostd.currentModel;
        if (model === null) return Ghostd.modelSource === "none";
        return Ghostd.modelSource === "explicit" && current !== null
            && current.provider === model.provider && current.id === model.id;
    }

    /** Stays open until the daemon answers: success closes, a refusal shows here. */
    function choose(model: var): void {
        if (Ghostd.modelWriting) return;
        if (model === null) Ghostd.clearChatModel();
        else Ghostd.setChatModel(model.provider, model.id);
    }

    ModelLogin {
        id: login
        objectName: "modelLogin"
        anchors.fill: parent
        visible: root.connecting
        closeLabel: "Back"
        // A sign-in that landed already re-listed the models (adoptLoginView).
        onCloseRequested: {
            root.connecting = false;
            Qt.callLater(search.focusInput);
        }
    }

    ColumnLayout {
        visible: !root.connecting
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            Text {
                text: "Choose a model"
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSubtitle
                font.weight: Font.DemiBold
            }

            Text {
                text: Ghostd.activeGhost === "" ? "" : "· " + Ghostd.activeGhost
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Item { Layout.fillWidth: true }

            ActionButton {
                objectName: "connectProvider"
                label: "Connect a provider"
                onClicked: root.connectProvider()
            }

            Text {
                text: "Close"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                MouseArea {
                    anchors.fill: parent
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.closeRequested()
                }
            }
        }

        SearchField {
            id: search
            objectName: "modelSearch"
            Layout.fillWidth: true
            placeholder: "Search models"
            onMoved: step => {
                modelList.currentIndex = Math.max(0,
                    Math.min(modelList.count - 1, modelList.currentIndex + step));
            }
            onAccepted: if (modelList.currentIndex >= 0 && modelList.currentIndex < root.rows.length)
                root.choose(root.rows[modelList.currentIndex])
        }

        Text {
            visible: Ghostd.modelError !== "" || Ghostd.modelWriting
                || Ghostd.availableModels.length === 0
            Layout.fillWidth: true
            text: Ghostd.modelError !== ""
                ? Ghostd.modelError
                : Ghostd.modelWriting ? "Switching…"
                : Ghostd.availableModelsRequest !== null
                    ? "Loading models…"
                    : "No models yet. Connect a provider to sign this ghost in."
            color: Ghostd.modelError !== "" ? Theme.danger : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.Wrap
        }

        ListView {
            id: modelList
            objectName: "modelList"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            spacing: Theme.gap / 2
            model: root.rows
            boundsBehavior: Flickable.StopAtBounds
            // Setting the model resets the index, so the highlight follows it.
            onModelChanged: root.resetHighlight()

            delegate: Rectangle {
                id: modelRow
                required property var modelData
                required property int index

                readonly property bool current: root.isCurrent(modelRow.modelData)

                objectName: modelRow.modelData === null
                    ? "model-default"
                    : "model-" + modelRow.modelData.provider + "/" + modelRow.modelData.id
                width: modelList.width
                implicitHeight: 44
                radius: Theme.radius / 2
                color: rowArea.containsMouse || modelList.currentIndex === modelRow.index
                    ? Theme.hover : Theme.surface
                border.width: modelRow.current ? 1 : 0
                border.color: Theme.accent

                ColumnLayout {
                    anchors.fill: parent
                    anchors.leftMargin: Theme.pad
                    anchors.rightMargin: Theme.pad
                    spacing: 0

                    Text {
                        text: modelRow.modelData === null
                            ? "Default"
                            : (modelRow.modelData.name || modelRow.modelData.id)
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }

                    Text {
                        text: (modelRow.modelData === null
                            ? "let pi choose from the signed-in providers"
                            : modelRow.modelData.provider + "/" + modelRow.modelData.id)
                            + (modelRow.current ? " · current" : "")
                        color: modelRow.current ? Theme.ok : Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        elide: Text.ElideRight
                        Layout.fillWidth: true
                    }
                }

                MouseArea {
                    id: rowArea
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.choose(modelRow.modelData)
                }
            }
        }
    }
}
