pragma ComponentBehavior: Bound

// A conversation's project is an explicit, trusted discovery boundary. The
// compact chip keeps that boundary visible beside the model; its panel stages
// path resolution, a count-only preview, trust, then the generation-checked
// bind. No cwd change silently opens this flow or selects a project.
import QtQuick
import QtQuick.Layouts
import qs.services
import "ProjectModel.js" as ProjectModel

FocusScope {
    id: root

    property bool panelOpen: false
    property bool compact: false
    property real availableWidth: 400
    property real availableHeight: 500
    property string mode: "overview"
    property string inputPath: ""
    property string pendingPath: ""
    property bool trustConfirmed: false
    property var recentPaths: []
    property double clock: Date.now()

    readonly property var binding: Ghostd.projectState || ProjectModel.empty()
    readonly property var preview: Ghostd.projectPreview
    readonly property bool unavailable: Ghostd.projectError !== ""
    readonly property bool attention: root.unavailable || root.binding.status === "degraded"
        || root.binding.mcpStatus === "degraded"
    readonly property bool previewExpired: root.preview
        && Date.parse(root.preview.expiresAt) <= root.clock
    readonly property bool inputIsAbsolute: ProjectModel.isAbsolute(root.inputPath.trim())
    readonly property string trustRisk: "This ghost runs in YOLO mode without approval prompts. "
        + "Project instructions can guide it to run commands and access files on your behalf."
    readonly property real panelWidth: Math.max(300, Math.min(410, root.availableWidth))

    implicitWidth: chip.implicitWidth
    implicitHeight: 28
    z: root.panelOpen ? 100 : 0
    activeFocusOnTab: true

    function show(): void {
        root.panelOpen = true;
        root.mode = "overview";
        root.trustConfirmed = false;
        Ghostd.fetchProject(false, true);
        chip.forceActiveFocus();
    }

    function hide(): void {
        root.panelOpen = false;
        root.mode = "overview";
        root.trustConfirmed = false;
    }

    function toggle(): void {
        if (root.panelOpen) root.hide();
        else root.show();
    }

    function beginChoose(): void {
        if (root.binding.canRebind !== true || Ghostd.projectMutating) return;
        root.mode = "choose";
        root.trustConfirmed = false;
        Ghostd.projectPreview = null;
        root.inputPath = root.binding.root || root.binding.cwd || "";
        Qt.callLater(function () { pathInput.forceActiveFocus(); });
    }

    function requestPreview(): void {
        const candidate = root.inputPath.trim();
        if (!root.inputIsAbsolute || Ghostd.projectPreviewLoading) return;
        root.pendingPath = candidate;
        root.trustConfirmed = false;
        Ghostd.previewProject(candidate);
    }

    function useRecent(path: string): void {
        root.inputPath = path;
        root.requestPreview();
    }

    function startNewConversation(): void {
        Ghostd.newConversation();
        root.mode = "overview";
        root.trustConfirmed = false;
    }

    Keys.onEscapePressed: event => {
        if (root.mode !== "overview") root.mode = "overview";
        else root.hide();
        event.accepted = true;
    }

    Timer {
        interval: 1000
        repeat: true
        running: root.panelOpen && root.preview !== null
        onTriggered: root.clock = Date.now()
    }

    Connections {
        target: Ghostd

        function onProjectPreviewFinished(ok: bool): void {
            if (!root.panelOpen || !ok) return;
            root.recentPaths = ProjectModel.remember(
                root.recentPaths, Ghostd.projectPreview.root, 5);
            root.inputPath = Ghostd.projectPreview.root;
            root.mode = "preview";
            root.trustConfirmed = false;
            root.clock = Date.now();
        }

        function onProjectMutationFinished(_action: string, ok: bool): void {
            if (!root.panelOpen || !ok) return;
            root.mode = "overview";
            root.trustConfirmed = false;
        }

        function onCurrentSessionIdChanged(): void {
            root.mode = "overview";
            root.trustConfirmed = false;
            if (root.panelOpen) Ghostd.fetchProject(false, true);
        }
    }

    Rectangle {
        id: chip
        objectName: "projectChipButton"

        width: Math.min(root.compact ? 136 : 214,
            chipRow.implicitWidth + Theme.pad * 1.4)
        implicitWidth: width
        height: 28
        radius: Theme.radius / 2
        color: root.panelOpen ? Theme.selection
            : (chipArea.containsMouse ? Theme.hover : "transparent")
        border.width: root.panelOpen || root.attention ? 1 : 0
        border.color: root.attention ? Theme.warn
            : (root.panelOpen ? Theme.accent : Theme.border)
        activeFocusOnTab: true

        Accessible.role: Accessible.Button
        Accessible.name: "Project: " + ProjectModel.title(root.binding)
        Accessible.description: ProjectModel.pathLabel(root.binding) + ", "
            + ProjectModel.statusLabel(root.binding) + ", generation "
            + root.binding.generation + ", " + ProjectModel.mcpLabel(root.binding)

        Row {
            id: chipRow
            anchors.centerIn: parent
            spacing: Theme.gap / 2

            Rectangle {
                anchors.verticalCenter: parent.verticalCenter
                width: 7
                height: 7
                radius: width / 2
                color: Ghostd.projectLoading ? Theme.foregroundDim
                    : (root.attention ? Theme.warn
                        : (root.binding.root === null ? Theme.foregroundDim : Theme.ghostAmberBright))
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                width: Math.min(implicitWidth, root.compact ? 86 : 108)
                text: Ghostd.projectLoading && root.binding.id === ""
                    ? "Project…" : ProjectModel.title(root.binding)
                color: root.attention ? Theme.warn : Theme.foreground
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                font.weight: Font.DemiBold
                elide: Text.ElideMiddle
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                visible: !root.compact && root.binding.root !== null
                width: Math.min(implicitWidth, 72)
                text: "· " + ProjectModel.pathLabel(root.binding)
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                elide: Text.ElideMiddle
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: root.panelOpen ? "⌃" : "⌄"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
        }

        MouseArea {
            id: chipArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.toggle()
        }

        Keys.onPressed: event => {
            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                    || event.key === Qt.Key_Space) {
                root.toggle();
                event.accepted = true;
            }
        }
    }

    Rectangle {
        id: panel
        objectName: "projectPanel"

        visible: root.panelOpen
        anchors.top: chip.bottom
        anchors.topMargin: Theme.gap
        anchors.right: chip.right
        width: root.panelWidth
        height: Math.max(220, Math.min(root.availableHeight,
            panelContent.implicitHeight + Theme.pad * 2))
        radius: Theme.radiusLarge
        color: Theme.surfaceDeep
        border.width: 1
        border.color: Theme.borderStrong
        clip: true
        z: 101

        Accessible.role: Accessible.Pane
        Accessible.name: "Conversation project"

        Flickable {
            anchors.fill: parent
            anchors.margins: Theme.pad
            contentWidth: width
            contentHeight: panelContent.implicitHeight
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            ColumnLayout {
                id: panelContent
                width: parent.width
                spacing: Theme.pad

                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.gap

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Theme.gap / 4

                        Text {
                            text: root.mode === "choose" ? "Choose a project"
                                : (root.mode === "preview" ? "Trust this project?"
                                    : (root.mode === "unbind" ? "Use Home instead?"
                                        : ProjectModel.title(root.binding)))
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize + 2
                            font.weight: Font.DemiBold
                        }

                        Text {
                            Layout.fillWidth: true
                            visible: root.mode === "overview"
                            text: ProjectModel.pathLabel(root.binding)
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            elide: Text.ElideMiddle
                        }
                    }

                    Rectangle {
                        implicitWidth: Theme.controlHeight
                        implicitHeight: Theme.controlHeight
                        radius: Theme.radius
                        color: closeArea.containsMouse ? Theme.film(0.08) : "transparent"
                        activeFocusOnTab: true
                        Accessible.role: Accessible.Button
                        Accessible.name: "Close project panel"

                        Text {
                            anchors.centerIn: parent
                            text: "×"
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize + 3
                        }
                        MouseArea {
                            id: closeArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.hide()
                        }
                        Keys.onPressed: event => {
                            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                    || event.key === Qt.Key_Space) {
                                root.hide();
                                event.accepted = true;
                            }
                        }
                    }
                }

                Text {
                    Layout.fillWidth: true
                    visible: Ghostd.projectLoading && root.binding.id === ""
                    text: "Loading this conversation’s project…"
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }

                Text {
                    Layout.fillWidth: true
                    visible: Ghostd.projectError !== ""
                    text: Ghostd.projectError
                    color: Theme.danger
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                    Accessible.role: Accessible.AlertMessage
                }

                Text {
                    Layout.fillWidth: true
                    visible: Ghostd.projectNotice !== "" && Ghostd.projectError === ""
                        && root.mode === "overview"
                    text: Ghostd.projectNotice
                    color: Theme.ghostAmberBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }

                ColumnLayout {
                    visible: root.mode === "overview" && root.binding.id !== ""
                    Layout.fillWidth: true
                    spacing: Theme.gap

                    Text {
                        id: statusText
                        objectName: "projectStatusText"
                        Layout.fillWidth: true
                        text: ProjectModel.statusLabel(root.binding) + " · Generation "
                            + root.binding.generation + " · " + ProjectModel.mcpLabel(root.binding)
                        color: root.attention ? Theme.warn : Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.binding.root !== null
                        text: root.binding.root || ""
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamilyMono
                        font.pixelSize: Theme.fontSizeSmall
                        elide: Text.ElideMiddle
                    }

                    Text {
                        Layout.fillWidth: true
                        text: ProjectModel.resourceSummary(root.binding)
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        Layout.fillWidth: true
                        text: ProjectModel.reasonLabel(root.binding)
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.binding.error !== null
                        text: root.binding.error ? root.binding.error.message : ""
                        color: Theme.warn
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.binding.resources.ignoredExecutable > 0
                        text: root.binding.resources.ignoredExecutable + " executable project artifact"
                            + (root.binding.resources.ignoredExecutable === 1 ? " was" : "s were")
                            + " ignored."
                        color: Theme.warn
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.gap

                        ProjectButton {
                            text: root.binding.root === null ? "Choose project" : "Change"
                            primary: root.binding.root === null
                            enabled: root.binding.canRebind && !Ghostd.projectMutating
                            onActivated: root.beginChoose()
                        }
                        ProjectButton {
                            visible: root.binding.root !== null && root.binding.canRebind
                            text: Ghostd.projectMutating ? "Reloading…" : "Reload"
                            enabled: !Ghostd.projectMutating
                            onActivated: Ghostd.reloadProject()
                        }
                        Item { Layout.fillWidth: true }
                        ProjectButton {
                            visible: root.binding.root !== null && root.binding.canRebind
                            text: "Use Home"
                            onActivated: root.mode = "unbind"
                        }
                    }

                    Rectangle {
                        visible: !root.binding.canRebind
                        Layout.fillWidth: true
                        implicitHeight: rebindColumn.implicitHeight + Theme.pad * 1.5
                        radius: Theme.radius
                        color: Theme.amber(0.07)
                        border.width: 1
                        border.color: Theme.amber(0.18)

                        ColumnLayout {
                            id: rebindColumn
                            anchors.fill: parent
                            anchors.margins: Theme.pad * 0.75
                            spacing: Theme.gap

                            Text {
                                Layout.fillWidth: true
                                text: "Claude Code fixes its project after the first message. "
                                    + "Start a new conversation to choose another project."
                                color: Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }
                            ProjectButton {
                                objectName: "newConversationButton"
                                text: "Start new conversation"
                                primary: true
                                onActivated: root.startNewConversation()
                            }
                        }
                    }
                }

                ColumnLayout {
                    visible: root.mode === "choose"
                    Layout.fillWidth: true
                    spacing: Theme.gap

                    Text {
                        Layout.fillWidth: true
                        text: "Enter an absolute folder path. Ghost resolves it first and shows only "
                            + "what it would discover; nothing is loaded until you confirm."
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        Layout.fillWidth: true
                        visible: root.inputPath.trim() !== "" && !root.inputIsAbsolute
                        text: "Use an absolute path beginning with /."
                        color: Theme.warn
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                        Accessible.role: Accessible.AlertMessage
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: Theme.controlHeight
                        radius: Theme.radius
                        color: Theme.surface
                        border.width: 1
                        border.color: pathInput.activeFocus ? Theme.accent : Theme.border

                        TextInput {
                            id: pathInput
                            objectName: "projectPathInput"
                            anchors.fill: parent
                            anchors.margins: Theme.gap
                            text: root.inputPath
                            onTextEdited: root.inputPath = text
                            color: Theme.foreground
                            selectionColor: Theme.selection
                            selectedTextColor: Theme.foregroundBright
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            clip: true
                            Accessible.name: "Project folder path"
                            Keys.onReturnPressed: root.requestPreview()
                            Keys.onEnterPressed: root.requestPreview()
                        }
                    }

                    Text {
                        visible: root.recentPaths.length > 0
                        text: "Recent previews"
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        font.weight: Font.DemiBold
                    }

                    Repeater {
                        model: root.recentPaths

                        Rectangle {
                            id: recentRow
                            required property string modelData
                            Layout.fillWidth: true
                            implicitHeight: Theme.controlHeight
                            radius: Theme.radius
                            color: recentArea.containsMouse ? Theme.film(0.06) : "transparent"
                            activeFocusOnTab: true
                            Accessible.role: Accessible.Button
                            Accessible.name: "Preview recent project " + recentRow.modelData

                            Text {
                                anchors.fill: parent
                                anchors.leftMargin: Theme.gap
                                anchors.rightMargin: Theme.gap
                                verticalAlignment: Text.AlignVCenter
                                text: recentRow.modelData
                                color: Theme.foreground
                                font.family: Theme.fontFamilyMono
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideMiddle
                            }
                            MouseArea {
                                id: recentArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.useRecent(recentRow.modelData)
                            }
                            Keys.onPressed: event => {
                                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space) {
                                    root.useRecent(recentRow.modelData);
                                    event.accepted = true;
                                }
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.gap
                        Item { Layout.fillWidth: true }
                        ProjectButton { text: "Cancel"; onActivated: root.mode = "overview" }
                        ProjectButton {
                            objectName: "previewButton"
                            text: Ghostd.projectPreviewLoading ? "Resolving…" : "Preview"
                            primary: true
                            enabled: root.inputIsAbsolute
                                && !Ghostd.projectPreviewLoading
                            onActivated: root.requestPreview()
                        }
                    }
                }

                ColumnLayout {
                    visible: root.mode === "preview" && root.preview !== null
                    Layout.fillWidth: true
                    spacing: Theme.gap

                    Text {
                        text: root.preview ? ProjectModel.title(root.preview) : ""
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        font.weight: Font.DemiBold
                    }
                    Text {
                        Layout.fillWidth: true
                        text: root.preview ? root.preview.root : ""
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamilyMono
                        font.pixelSize: Theme.fontSizeSmall
                        elide: Text.ElideMiddle
                    }
                    Text {
                        Layout.fillWidth: true
                        text: root.preview ? ProjectModel.resourceSummary(root.preview) : ""
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Repeater {
                        model: root.preview ? root.preview.warnings : []
                        Text {
                            required property string modelData
                            Layout.fillWidth: true
                            text: "⚠ " + modelData
                            color: Theme.warn
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }
                    }

                    Text {
                        visible: root.previewExpired
                        Layout.fillWidth: true
                        text: "This preview expired. Go back and resolve the folder again."
                        color: Theme.warn
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }

                    Rectangle {
                        Layout.fillWidth: true
                        implicitHeight: riskCopy.implicitHeight + Theme.pad * 1.5
                        radius: Theme.radius
                        color: Theme.rose(0.07)
                        border.width: 1
                        border.color: Theme.rose(0.20)

                        Text {
                            id: riskCopy
                            objectName: "trustRiskWarning"
                            anchors.fill: parent
                            anchors.margins: Theme.pad * 0.75
                            text: root.trustRisk
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                            Accessible.role: Accessible.AlertMessage
                        }
                    }

                    Rectangle {
                        id: trustRow
                        objectName: "trustToggle"
                        Layout.fillWidth: true
                        implicitHeight: trustLabel.implicitHeight + Theme.pad * 1.5
                        radius: Theme.radius
                        color: trustArea.containsMouse ? Theme.amber(0.09) : Theme.amber(0.06)
                        border.width: 1
                        border.color: root.trustConfirmed ? Theme.amber(0.45) : Theme.amber(0.18)
                        activeFocusOnTab: true
                        Accessible.role: Accessible.CheckBox
                        Accessible.name: "Trust this project"
                        Accessible.description: root.trustRisk
                        Accessible.checked: root.trustConfirmed

                        RowLayout {
                            anchors.fill: parent
                            anchors.margins: Theme.pad * 0.75
                            spacing: Theme.gap

                            Rectangle {
                                implicitWidth: 17
                                implicitHeight: 17
                                radius: 4
                                color: root.trustConfirmed ? Theme.amber(0.28) : "transparent"
                                border.width: 1
                                border.color: root.trustConfirmed
                                    ? Theme.ghostAmberBright : Theme.borderStrong
                                Text {
                                    anchors.centerIn: parent
                                    visible: root.trustConfirmed
                                    text: "✓"
                                    color: Theme.ghostAmberBright
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                }
                            }
                            Text {
                                id: trustLabel
                                objectName: "projectTrustCopy"
                                Layout.fillWidth: true
                                text: "I trust this folder’s instructions, skills, commands, "
                                    + "and MCP server definitions."
                                color: Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }
                        }
                        MouseArea {
                            id: trustArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.trustConfirmed = !root.trustConfirmed
                        }
                        Keys.onPressed: event => {
                            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                    || event.key === Qt.Key_Space) {
                                root.trustConfirmed = !root.trustConfirmed;
                                event.accepted = true;
                            }
                        }
                    }

                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.gap
                        ProjectButton { text: "Back"; onActivated: root.mode = "choose" }
                        Item { Layout.fillWidth: true }
                        ProjectButton {
                            objectName: "bindButton"
                            text: Ghostd.projectMutating ? "Selecting…" : "Trust & use project"
                            primary: true
                            enabled: root.trustConfirmed && !root.previewExpired
                                && !Ghostd.projectMutating && root.binding.canRebind
                            onActivated: Ghostd.bindProject()
                        }
                    }
                }

                ColumnLayout {
                    visible: root.mode === "unbind"
                    Layout.fillWidth: true
                    spacing: Theme.pad

                    Text {
                        objectName: "projectUnbindCopy"
                        Layout.fillWidth: true
                        text: "This conversation will stop loading project instructions, skills, "
                            + "commands, and MCP servers. Its working directory returns to Home. "
                            + "No project or ghost files are changed."
                        color: Theme.foreground
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        spacing: Theme.gap
                        Item { Layout.fillWidth: true }
                        ProjectButton { text: "Cancel"; onActivated: root.mode = "overview" }
                        ProjectButton {
                            objectName: "unbindButton"
                            text: Ghostd.projectMutating ? "Returning…" : "Use Home"
                            primary: true
                            enabled: !Ghostd.projectMutating
                            onActivated: Ghostd.unbindProject()
                        }
                    }
                }
            }
        }
    }

    component ProjectButton: Rectangle {
        id: button

        property string text: ""
        property bool primary: false
        signal activated()

        implicitWidth: buttonLabel.implicitWidth + Theme.pad * 1.5
        implicitHeight: Theme.controlHeight
        radius: Theme.radius
        color: !button.enabled ? Theme.film(0.025)
            : (buttonArea.containsMouse
                ? (button.primary ? Theme.amber(0.20) : Theme.film(0.09))
                : (button.primary ? Theme.amber(0.13) : Theme.film(0.05)))
        border.width: button.primary ? 1 : 0
        border.color: Theme.amber(0.24)
        opacity: button.enabled ? 1 : 0.55
        activeFocusOnTab: true
        Accessible.role: Accessible.Button
        Accessible.name: button.text

        Text {
            id: buttonLabel
            anchors.centerIn: parent
            text: button.text
            color: button.primary ? Theme.ghostAmberBright : Theme.foreground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.weight: button.primary ? Font.DemiBold : Font.Normal
        }
        MouseArea {
            id: buttonArea
            anchors.fill: parent
            enabled: button.enabled
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: button.activated()
        }
        Keys.onPressed: event => {
            if (button.enabled && (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                    || event.key === Qt.Key_Space)) {
                button.activated();
                event.accepted = true;
            }
        }
    }
}
