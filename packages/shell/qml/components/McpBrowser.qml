pragma ComponentBehavior: Bound

// Manage the active ghost's visible mcp.json servers. The catalog is intentionally
// sanitized: credentials are described only as configured key names/counts.
// Editing is a full replacement, so any hidden values must be re-entered and
// explicitly acknowledged before the UI will send the new JSON.
import QtQuick
import QtQuick.Layouts
import "../services"
import "McpConfig.js" as McpConfig

Rectangle {
    id: root

    property string searchText: ""
    property string selectedName: ""
    property bool editorOpen: false
    property bool adding: false
    property string editorName: ""
    property string editorType: "stdio"
    property string editorJson: ""
    property string editorError: ""
    property bool hiddenValuesAcknowledged: false
    property string pendingDeleteName: ""

    readonly property var servers: Array.isArray(Ghostd.mcpServers)
        ? Ghostd.mcpServers : []
    readonly property var filteredServers: McpConfig.filtered(root.servers, root.searchText)
    readonly property var selectedServer: root.findServer(root.selectedName)
    readonly property bool editingHiddenValues: !root.adding && root.selectedServer
        && McpConfig.hasHiddenValues(root.selectedServer)

    implicitWidth: Theme.pad * 50
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function textOf(value: var): string {
        return value === undefined || value === null ? "" : String(value);
    }

    function findServer(name: string): var {
        for (let i = 0; i < root.servers.length; i++) {
            if (root.servers[i] && root.servers[i].name === name) return root.servers[i];
        }
        return null;
    }

    function ensureSelection(): void {
        if (root.selectedServer) return;
        root.selectedName = root.servers.length > 0 ? root.servers[0].name : "";
    }

    function beginAdd(): void {
        root.adding = true;
        root.editorOpen = true;
        root.editorName = "";
        root.editorType = "stdio";
        root.editorJson = McpConfig.template(null, root.editorType);
        root.editorError = "";
        root.hiddenValuesAcknowledged = false;
    }

    function beginEdit(): void {
        if (!root.selectedServer) return;
        root.adding = false;
        root.editorOpen = true;
        root.editorName = root.selectedServer.name;
        root.editorType = McpConfig.transport(root.selectedServer);
        root.editorJson = McpConfig.template(root.selectedServer, root.editorType);
        root.editorError = "";
        root.hiddenValuesAcknowledged = false;
    }

    function cancelEdit(): void {
        if (Ghostd.mcpMutating) return;
        root.editorOpen = false;
        root.editorError = "";
        root.hiddenValuesAcknowledged = false;
    }

    function selectTransport(type: string): void {
        if (type === root.editorType) return;
        root.editorType = type;
        root.editorJson = McpConfig.template(root.adding ? null : root.selectedServer, type);
        root.editorError = "";
        root.hiddenValuesAcknowledged = false;
    }

    function save(): void {
        const name = root.editorName.trim();
        if (name === "") {
            root.editorError = "Give the server a name.";
            return;
        }
        if (root.editingHiddenValues && !root.hiddenValuesAcknowledged) {
            root.editorError = "Confirm that every hidden value has been re-entered.";
            return;
        }
        const parsed = McpConfig.parse(root.editorJson, root.editorType);
        if (!parsed.ok) {
            root.editorError = parsed.error;
            return;
        }
        root.editorError = "";
        if (root.adding) Ghostd.addMcpServer(name, parsed.config);
        else Ghostd.updateMcpServer(root.selectedName, parsed.config);
    }

    function hiddenSummary(server: var): string {
        if (!server || !server.config) return "";
        const config = server.config;
        const parts = [];
        const argumentsCount = Number(config.argumentCount || 0);
        if (argumentsCount > 0)
            parts.push(argumentsCount + " command argument" + (argumentsCount === 1 ? "" : "s"));
        const env = McpConfig.configuredKeys(config.environment);
        if (env.length > 0) parts.push("environment: " + env.join(", "));
        const headers = McpConfig.configuredKeys(config.headers);
        if (headers.length > 0) parts.push("headers: " + headers.join(", "));
        if (config.auth && config.auth.configured === true) parts.push("authentication");
        if (config.oauth && config.oauth.configured === true) parts.push("OAuth client settings");
        if (McpConfig.remoteUrlIsRedacted(config.url)) parts.push("URL query values");
        return parts.join(" · ");
    }

    Component.onCompleted: {
        root.ensureSelection();
        if (Ghostd.activeGhost !== "") Ghostd.fetchMcp(false);
    }
    onVisibleChanged: if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchMcp(false)

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            root.searchText = "";
            root.selectedName = "";
            root.editorOpen = false;
            root.pendingDeleteName = "";
            if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchMcp(false);
        }

        function onMcpServersChanged(): void {
            root.ensureSelection();
        }

        function onMcpMutationFinished(action: string, server: string, ok: bool): void {
            if (!ok) return;
            if (action === "delete" && root.pendingDeleteName === server) {
                root.pendingDeleteName = "";
                if (root.selectedName === server) root.selectedName = "";
                root.ensureSelection();
            }
            if ((action === "add" || action === "update")
                    && root.editorName === server) {
                root.editorOpen = false;
                root.selectedName = server;
            }
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.gap

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            ColumnLayout {
                Layout.fillWidth: true
                spacing: Theme.gap / 3

                Text {
                    text: "MCP servers"
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeHeading
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.fillWidth: true
                    text: "Tools for " + (Ghostd.activeGhost || "this ghost")
                        + ". Secret values are write-only."
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            ActionButton {
                id: refreshButton

                label: Ghostd.mcpLoading ? "Refreshing" : "Refresh"
                enabled: Ghostd.activeGhost !== "" && !Ghostd.mcpLoading && !Ghostd.mcpMutating
                onClicked: Ghostd.fetchMcp(true)
            }

            ActionButton {
                id: addButton

                label: "+ Add server"
                primary: true
                enabled: Ghostd.activeGhost !== "" && !Ghostd.mcpMutating
                onClicked: root.beginAdd()
            }
        }

        Text {
            Layout.fillWidth: true
            visible: Ghostd.mcpError !== ""
            text: Ghostd.mcpError
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }

        Text {
            Layout.fillWidth: true
            visible: Ghostd.mcpNotice !== "" && Ghostd.mcpError === ""
            text: Ghostd.mcpNotice
            color: Theme.ghostAmber
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        Rectangle { Layout.fillWidth: true; implicitHeight: 1; color: Theme.border }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: Theme.sectionGap

            ColumnLayout {
                Layout.preferredWidth: Theme.pad * 15
                Layout.minimumWidth: Theme.pad * 12
                Layout.maximumWidth: Theme.ch(40)
                Layout.fillHeight: true
                spacing: Theme.gap

                Rectangle {
                    Layout.fillWidth: true
                    implicitHeight: Theme.controlHeight
                    radius: Theme.radius
                    color: Theme.film(0.05)
                    border.width: serverSearch.activeFocus ? 1 : 0
                    border.color: Theme.amber(0.5)

                    TextInput {
                        id: serverSearch
                        anchors.fill: parent
                        anchors.leftMargin: Theme.pad
                        anchors.rightMargin: Theme.pad
                        verticalAlignment: TextInput.AlignVCenter
                        text: root.searchText
                        onTextChanged: root.searchText = text
                        color: Theme.foregroundBright
                        selectionColor: Theme.selection
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        clip: true

                        Text {
                            anchors.fill: parent
                            verticalAlignment: Text.AlignVCenter
                            visible: serverSearch.text === ""
                            text: "Search servers"
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                    }
                }

                ListView {
                    id: serverList
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    model: root.filteredServers
                    spacing: Theme.gap / 2
                    clip: true

                    delegate: Rectangle {
                        id: serverRow
                        required property var modelData
                        readonly property bool selected: root.selectedName === serverRow.modelData.name

                        width: serverList.width
                        height: serverText.implicitHeight + Theme.pad
                        radius: Theme.radius
                        color: serverRow.selected ? Theme.selection
                            : (serverArea.containsMouse ? Theme.hover : "transparent")
                        border.width: serverRow.activeFocus ? 1 : 0
                        border.color: Theme.amber(0.5)
                        activeFocusOnTab: true

                        Column {
                            id: serverText
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.gap
                            anchors.right: parent.right
                            anchors.rightMargin: Theme.gap
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: 2

                            Row {
                                width: parent.width
                                spacing: Theme.gap / 2
                                Text {
                                    width: parent.width - stateDot.width - parent.spacing
                                    text: serverRow.modelData.name
                                    color: Theme.foregroundBright
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    font.weight: Font.DemiBold
                                    elide: Text.ElideRight
                                }
                                Rectangle {
                                    id: stateDot
                                    anchors.verticalCenter: parent.verticalCenter
                                    width: 7; height: 7; radius: 4
                                    color: serverRow.modelData.enabled === false
                                        ? Theme.foregroundFaint : Theme.ghostAmber
                                }
                            }
                            Text {
                                width: parent.width
                                text: McpConfig.transport(serverRow.modelData).toUpperCase()
                                    + " · " + root.textOf(serverRow.modelData.source || "ghost")
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamilyMono
                                font.pixelSize: Theme.fontSizeCaption
                                elide: Text.ElideRight
                            }
                        }

                        MouseArea {
                            id: serverArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: {
                                root.selectedName = serverRow.modelData.name;
                                root.editorOpen = false;
                            }
                        }
                        Keys.onReturnPressed: event => {
                            root.selectedName = serverRow.modelData.name;
                            root.editorOpen = false;
                            event.accepted = true;
                        }
                    }

                    Text {
                        anchors.centerIn: parent
                        width: parent.width - Theme.pad * 2
                        visible: !Ghostd.mcpLoading && root.filteredServers.length === 0
                        text: root.searchText.trim() === ""
                            ? "No MCP servers yet" : "No matching servers"
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        horizontalAlignment: Text.AlignHCenter
                        wrapMode: Text.WordWrap
                    }
                }
            }

            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                radius: Theme.radius
                color: Theme.surface
                border.width: 1
                border.color: Theme.border

                Flickable {
                    id: detailScroll
                    anchors.fill: parent
                    anchors.margins: Theme.pad
                    contentWidth: width
                    contentHeight: Math.max(height, detailColumn.implicitHeight)
                    clip: true
                    interactive: contentHeight > height
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: detailColumn
                        width: detailScroll.width
                        spacing: Theme.pad

                        Column {
                            width: parent.width
                            visible: !root.editorOpen && root.selectedServer !== null
                            spacing: Theme.gap

                            Row {
                                width: parent.width
                                spacing: Theme.gap

                                Column {
                                    width: parent.width - detailActions.width - Theme.gap
                                    spacing: 2
                                    Text {
                                        width: parent.width
                                        text: root.selectedServer ? root.selectedServer.name : ""
                                        color: Theme.foregroundBright
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeHeading
                                        font.weight: Font.DemiBold
                                        elide: Text.ElideRight
                                    }
                                    Text {
                                        width: parent.width
                                        text: root.selectedServer
                                            ? McpConfig.transport(root.selectedServer).toUpperCase()
                                                + " · " + root.textOf(root.selectedServer.path)
                                            : ""
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamilyMono
                                        font.pixelSize: Theme.fontSizeSmall
                                        elide: Text.ElideMiddle
                                    }
                                }

                                Row {
                                    id: detailActions
                                    spacing: Theme.gap / 2

                                    Repeater {
                                        model: [
                                            { id: "toggle", label: root.selectedServer
                                                && root.selectedServer.enabled === false ? "Enable" : "Disable" },
                                            { id: "edit", label: "Edit" },
                                            { id: "delete", label: "Delete" }
                                        ]
                                        Rectangle {
                                            id: actionButton
                                            required property var modelData
                                            implicitWidth: actionLabel.implicitWidth + Theme.pad
                                            implicitHeight: Theme.controlHeight - Theme.gap / 2
                                            radius: Theme.radius
                                            color: actionArea.containsMouse ? Theme.film(0.09) : Theme.film(0.05)
                                            border.width: actionButton.modelData.id === "delete" ? 1 : 0
                                            border.color: Theme.rose(0.24)
                                            enabled: !Ghostd.mcpMutating

                                            Text {
                                                id: actionLabel
                                                anchors.centerIn: parent
                                                text: actionButton.modelData.label
                                                color: actionButton.modelData.id === "delete"
                                                    ? Theme.danger : Theme.foreground
                                                font.family: Theme.fontFamily
                                                font.pixelSize: Theme.fontSizeSmall
                                            }
                                            MouseArea {
                                                id: actionArea
                                                anchors.fill: parent
                                                enabled: actionButton.enabled
                                                hoverEnabled: true
                                                cursorShape: Qt.PointingHandCursor
                                                onClicked: {
                                                    if (!root.selectedServer) return;
                                                    if (actionButton.modelData.id === "toggle")
                                                        Ghostd.setMcpEnabled(root.selectedServer.name,
                                                            root.selectedServer.enabled === false);
                                                    else if (actionButton.modelData.id === "edit") root.beginEdit();
                                                    else root.pendingDeleteName = root.selectedServer.name;
                                                }
                                            }
                                        }
                                    }
                                }
                            }

                            Rectangle { width: parent.width; height: 1; color: Theme.border }

                            Column {
                                width: parent.width
                                spacing: Theme.gap / 2
                                Text {
                                    width: parent.width
                                    text: root.selectedServer && root.selectedServer.enabled === false
                                        ? "Disabled" : "Enabled"
                                    color: root.selectedServer && root.selectedServer.enabled === false
                                        ? Theme.foregroundDim : Theme.ghostAmber
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold
                                }
                                Text {
                                    width: parent.width
                                    text: root.selectedServer ? McpConfig.summary(root.selectedServer) : ""
                                    color: Theme.foregroundBright
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSize
                                    wrapMode: Text.WrapAnywhere
                                }
                            }

                            Rectangle {
                                width: parent.width
                                height: hiddenDetail.implicitHeight + Theme.pad
                                visible: root.selectedServer
                                    && McpConfig.hasHiddenValues(root.selectedServer)
                                radius: Theme.radius
                                color: Theme.amber(0.07)
                                border.width: 1
                                border.color: Theme.amber(0.16)

                                Text {
                                    id: hiddenDetail
                                    anchors.left: parent.left
                                    anchors.leftMargin: Theme.pad / 2
                                    anchors.right: parent.right
                                    anchors.rightMargin: Theme.pad / 2
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: "Configured but hidden: " + root.hiddenSummary(root.selectedServer)
                                        + ". Values never leave the daemon."
                                    color: Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    wrapMode: Text.WordWrap
                                }
                            }

                            Column {
                                width: parent.width
                                visible: Ghostd.mcpSkipped.length > 0
                                spacing: Theme.gap / 2
                                Text {
                                    text: "Skipped configuration"
                                    color: Theme.warn
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold
                                }
                                Repeater {
                                    model: Ghostd.mcpSkipped
                                    Text {
                                        required property var modelData
                                        width: parent.width
                                        text: root.textOf(modelData.path) + " — " + root.textOf(modelData.reason)
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamilyMono
                                        font.pixelSize: Theme.fontSizeCaption
                                        wrapMode: Text.WrapAnywhere
                                    }
                                }
                            }
                        }

                        Column {
                            width: parent.width
                            visible: root.editorOpen
                            spacing: Theme.gap

                            Text {
                                text: root.adding ? "Add MCP server" : "Replace " + root.editorName
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeHeading
                                font.weight: Font.DemiBold
                            }

                            Text {
                                width: parent.width
                                text: root.adding
                                    ? "Paste the complete MCP configuration. Secret values are sent only when you save."
                                    : "GET never returns credentials. This editor starts from safe fields only and replaces the complete configuration."
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }

                            Text { text: "Name"; color: Theme.foreground; font.family: Theme.fontFamily; font.pixelSize: Theme.fontSizeSmall }
                            Rectangle {
                                width: parent.width
                                height: Theme.controlHeight
                                radius: Theme.radius
                                color: Theme.film(0.05)
                                border.width: editorNameInput.activeFocus ? 1 : 0
                                border.color: Theme.amber(0.5)
                                TextInput {
                                    id: editorNameInput
                                    anchors.fill: parent
                                    anchors.leftMargin: Theme.pad
                                    anchors.rightMargin: Theme.pad
                                    verticalAlignment: TextInput.AlignVCenter
                                    text: root.editorName
                                    onTextChanged: root.editorName = text
                                    enabled: root.adding && !Ghostd.mcpMutating
                                    color: enabled ? Theme.foregroundBright : Theme.foregroundDim
                                    selectionColor: Theme.selection
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSize
                                    clip: true
                                }
                            }

                            Text { text: "Transport"; color: Theme.foreground; font.family: Theme.fontFamily; font.pixelSize: Theme.fontSizeSmall }
                            Row {
                                spacing: Theme.gap / 2
                                Repeater {
                                    model: ["stdio", "http", "sse"]
                                    Rectangle {
                                        id: transportButton
                                        required property string modelData
                                        implicitWidth: transportLabel.implicitWidth + Theme.pad
                                        implicitHeight: Theme.controlHeight - Theme.gap / 2
                                        radius: Theme.radius
                                        color: root.editorType === transportButton.modelData
                                            ? Theme.selection : Theme.film(0.05)
                                        border.width: 1
                                        border.color: root.editorType === transportButton.modelData
                                            ? Theme.amber(0.4) : Theme.border
                                        Text {
                                            id: transportLabel
                                            anchors.centerIn: parent
                                            text: transportButton.modelData.toUpperCase()
                                            color: Theme.foreground
                                            font.family: Theme.fontFamilyMono
                                            font.pixelSize: Theme.fontSizeSmall
                                        }
                                        MouseArea {
                                            anchors.fill: parent
                                            enabled: !Ghostd.mcpMutating
                                            hoverEnabled: true
                                            cursorShape: Qt.PointingHandCursor
                                            onClicked: root.selectTransport(transportButton.modelData)
                                        }
                                    }
                                }
                            }

                            Text { text: "Configuration JSON"; color: Theme.foreground; font.family: Theme.fontFamily; font.pixelSize: Theme.fontSizeSmall }
                            Rectangle {
                                width: parent.width
                                height: Math.max(180, Math.min(300, detailScroll.height * 0.45))
                                radius: Theme.radius
                                color: Theme.film(0.04)
                                border.width: configEditor.activeFocus ? 1 : 0
                                border.color: Theme.amber(0.45)

                                Flickable {
                                    id: configScroll
                                    anchors.fill: parent
                                    anchors.margins: Theme.gap
                                    contentWidth: width
                                    contentHeight: Math.max(height, configEditor.implicitHeight)
                                    clip: true

                                    TextEdit {
                                        id: configEditor
                                        width: configScroll.width
                                        text: root.editorJson
                                        onTextChanged: root.editorJson = text
                                        enabled: !Ghostd.mcpMutating
                                        color: Theme.foregroundBright
                                        selectionColor: Theme.selection
                                        selectedTextColor: Theme.foregroundBright
                                        font.family: Theme.fontFamilyMono
                                        font.pixelSize: Theme.fontSizeSmall
                                        textFormat: TextEdit.PlainText
                                        wrapMode: TextEdit.WrapAnywhere
                                        selectByMouse: true
                                    }
                                }
                            }

                            Rectangle {
                                width: parent.width
                                height: acknowledgeText.implicitHeight + Theme.pad
                                visible: root.editingHiddenValues
                                radius: Theme.radius
                                color: Theme.amber(0.07)
                                border.width: 1
                                border.color: Theme.amber(0.18)

                                Row {
                                    anchors.left: parent.left
                                    anchors.leftMargin: Theme.pad / 2
                                    anchors.right: parent.right
                                    anchors.rightMargin: Theme.pad / 2
                                    anchors.verticalCenter: parent.verticalCenter
                                    spacing: Theme.gap

                                    Rectangle {
                                        width: 18; height: 18; radius: 3
                                        color: root.hiddenValuesAcknowledged
                                            ? Theme.amber(0.22) : Theme.film(0.05)
                                        border.width: 1
                                        border.color: root.hiddenValuesAcknowledged
                                            ? Theme.ghostAmber : Theme.border
                                        Text {
                                            anchors.centerIn: parent
                                            text: root.hiddenValuesAcknowledged ? "✓" : ""
                                            color: Theme.ghostAmberBright
                                            font.pixelSize: Theme.fontSizeSmall
                                        }
                                    }
                                    Text {
                                        id: acknowledgeText
                                        width: parent.width - 18 - parent.spacing
                                        text: "I re-entered every hidden argument, environment value, header, URL query value, and credential this server needs."
                                        color: Theme.foreground
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        wrapMode: Text.WordWrap
                                    }
                                }
                                MouseArea {
                                    anchors.fill: parent
                                    enabled: !Ghostd.mcpMutating
                                    cursorShape: Qt.PointingHandCursor
                                    onClicked: root.hiddenValuesAcknowledged = !root.hiddenValuesAcknowledged
                                }
                            }

                            Text {
                                width: parent.width
                                visible: root.editorError !== ""
                                text: root.editorError
                                color: Theme.danger
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }

                            Row {
                                anchors.right: parent.right
                                spacing: Theme.gap
                                Rectangle {
                                    implicitWidth: cancelLabel.implicitWidth + Theme.pad * 1.5
                                    implicitHeight: Theme.controlHeight
                                    radius: Theme.radius
                                    color: cancelArea.containsMouse ? Theme.film(0.09) : Theme.film(0.05)
                                    Text {
                                        id: cancelLabel
                                        anchors.centerIn: parent
                                        text: "Cancel"
                                        color: Theme.foreground
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                    }
                                    MouseArea {
                                        id: cancelArea
                                        anchors.fill: parent
                                        enabled: !Ghostd.mcpMutating
                                        hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: root.cancelEdit()
                                    }
                                }
                                Rectangle {
                                    implicitWidth: saveLabel.implicitWidth + Theme.pad * 1.5
                                    implicitHeight: Theme.controlHeight
                                    radius: Theme.radius
                                    color: saveArea.containsMouse ? Theme.amber(0.20) : Theme.amber(0.13)
                                    border.width: 1
                                    border.color: Theme.amber(0.28)
                                    Text {
                                        id: saveLabel
                                        anchors.centerIn: parent
                                        text: Ghostd.mcpMutating ? "Saving…" : "Save"
                                        color: Theme.ghostAmberBright
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        font.weight: Font.DemiBold
                                    }
                                    MouseArea {
                                        id: saveArea
                                        anchors.fill: parent
                                        enabled: !Ghostd.mcpMutating
                                        hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: root.save()
                                    }
                                }
                            }
                        }

                        Text {
                            width: parent.width
                            visible: !root.editorOpen && root.selectedServer === null
                            text: Ghostd.mcpLoading ? "Loading MCP servers…"
                                : (Ghostd.activeGhost === "" ? "Select a ghost to manage MCP servers."
                                    : "Add an MCP server to give this ghost another local tool.")
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }
        }
    }

    ConfirmDialog {
        anchors.fill: parent
        open: root.pendingDeleteName !== ""
        title: "Delete MCP server?"
        body: "Remove “" + root.pendingDeleteName + "” from this ghost's mcp.json?"
        confirmText: "Delete"
        busy: Ghostd.mcpMutating
        error: root.pendingDeleteName !== "" ? Ghostd.mcpError : ""
        onConfirmed: Ghostd.deleteMcpServer(root.pendingDeleteName)
        onDismissed: if (!Ghostd.mcpMutating) root.pendingDeleteName = ""
    }
}
