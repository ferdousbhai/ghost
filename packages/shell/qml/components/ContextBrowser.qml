pragma ComponentBehavior: Bound

// Browse the active ghost's durable context without bringing the conversation
// sidebar along. Documents and character remain real files; memory and helper
// definitions are deliberately rendered as read-only snapshot data.
import QtQuick
import qs.services

Rectangle {
    id: root

    /** One of docs, memory, agents, or character. */
    required property string section

    property string selectedDocPath: ""
    property string selectedMemorySlug: ""
    property string selectedAgentName: ""
    property bool narrowDetailOpen: false
    property bool characterPaneOpen: true
    property alias docSearchText: searchInput.text

    readonly property bool validSection: ["docs", "memory", "agents", "character"]
        .indexOf(root.section) >= 0
    readonly property int indexWidth: Theme.pad * 13
    readonly property int detailMinimumWidth: Theme.pad * 17 + Theme.gap
    readonly property bool narrow: root.width
        < root.indexWidth + root.detailMinimumWidth + Theme.sectionGap

    readonly property var docs: Array.isArray(Ghostd.contextDocs)
        ? Ghostd.contextDocs : []
    readonly property var memory: Array.isArray(Ghostd.contextMemory)
        ? Ghostd.contextMemory : []
    readonly property var agents: Array.isArray(Ghostd.contextAgents)
        ? Ghostd.contextAgents : []
    readonly property var skipped: Array.isArray(Ghostd.contextSkipped)
        ? Ghostd.contextSkipped : []
    readonly property var character: Ghostd.contextCharacter || null

    readonly property string docQuery: root.docSearchText.trim().toLowerCase()
    readonly property var filteredDocs: root.docs.filter(function (doc) {
        if (root.docQuery === "") return true;
        const tags = doc && Array.isArray(doc.tags) ? doc.tags.join(" ") : "";
        const haystack = root.textOf(doc ? doc.title : "") + " "
            + root.textOf(doc ? doc.relativePath : "") + " " + tags;
        return haystack.toLowerCase().indexOf(root.docQuery) >= 0;
    })
    readonly property var sectionRows: {
        if (root.section === "docs") return root.filteredDocs;
        if (root.section === "memory") return root.memory;
        if (root.section === "agents") return root.agents;
        return [];
    }
    readonly property var skippedForSection: root.skipped.filter(function (entry) {
        return entry && entry.section === root.section;
    })

    readonly property var selectedDoc: root.findBy(root.docs, "path", root.selectedDocPath)
    readonly property var selectedMemory:
        root.findBy(root.memory, "slug", root.selectedMemorySlug)
    readonly property var selectedAgent:
        root.findBy(root.agents, "name", root.selectedAgentName)

    readonly property string editorRelativePath: {
        if (root.section === "docs" && root.selectedDoc)
            return root.textOf(root.selectedDoc.path);
        if (root.section === "character" && root.characterPaneOpen && root.character)
            return root.textOf(root.character.path);
        return "";
    }
    readonly property string editorAbsolutePath: root.editorRelativePath === ""
        ? "" : Workbench.absolute(root.editorRelativePath)
    readonly property bool editorVisible: root.editorAbsolutePath !== ""
        && ((root.section === "docs" && root.selectedDoc)
            || (root.section === "character" && root.characterPaneOpen))

    readonly property var agentFields: {
        const agent = root.selectedAgent;
        if (!agent) return [];
        return [
            { label: "Source", value: root.valueOr(agent.source, "Not specified") },
            { label: "Tools", value: root.toolValue(agent.tools) },
            { label: "Model routing", value: root.modelValue(agent.model) },
            { label: "Can delegate to", value: root.spawnValue(agent.spawns) }
        ];
    }

    implicitWidth: Theme.pad * 50
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function textOf(value: var): string {
        return value === undefined || value === null ? "" : String(value);
    }

    function valueOr(value: var, fallback: string): string {
        const text = root.textOf(value).trim();
        return text === "" ? fallback : text;
    }

    function toolValue(value: var): string {
        if (!Array.isArray(value) || value.length === 0) return "All available tools";
        return value.join(", ");
    }

    function modelValue(value: var): string {
        if (!Array.isArray(value) || value.length === 0) return "Active model";
        return value.join(", ");
    }

    function spawnValue(value: var): string {
        if (value === "*") return "Any available wisp";
        if (!Array.isArray(value)) return "No one";
        return value.length === 0 ? "None" : value.join(", ");
    }

    function findBy(rows: var, key: string, value: string): var {
        if (value === "") return null;
        for (let i = 0; i < rows.length; i++) {
            if (rows[i] && root.textOf(rows[i][key]) === value) return rows[i];
        }
        return null;
    }

    function sectionTitle(): string {
        if (root.section === "docs") return "Docs";
        if (root.section === "memory") return "Memory";
        if (root.section === "agents") return "Wisps";
        if (root.section === "character") return "Character";
        return "Context";
    }

    function docTitle(doc: var): string {
        if (!doc) return "Untitled document";
        return root.valueOr(doc.title, root.valueOr(doc.relativePath, "Untitled document"));
    }

    function memoryTitle(item: var): string {
        return item ? root.valueOr(item.slug, "Memory") : "Memory";
    }

    function rowTitle(row: var): string {
        if (root.section === "docs") return root.docTitle(row);
        if (root.section === "memory") return root.memoryTitle(row);
        if (root.section === "agents") return root.valueOr(row ? row.name : "", "Unnamed wisp");
        return "";
    }

    function rowSubtitle(row: var): string {
        if (root.section === "docs") return root.valueOr(row ? row.relativePath : "", "Path unavailable");
        if (root.section === "memory") return root.valueOr(row ? row.description : "", "No description");
        if (root.section === "agents") return root.valueOr(row ? row.description : "", "No description");
        return "";
    }

    function rowMeta(row: var): string {
        if (root.section === "docs") {
            const tags = row && Array.isArray(row.tags) && row.tags.length > 0
                ? row.tags.join(" · ") : "";
            const archived = row && row.archived === true ? "Archived" : "";
            return archived !== "" && tags !== "" ? archived + " · " + tags
                : (archived !== "" ? archived : tags);
        }
        if (root.section === "memory") {
            const updated = root.textOf(row ? row.updated : "");
            return updated === "" ? "Update time unavailable" : "Updated " + updated;
        }
        if (root.section === "agents")
            return root.valueOr(row ? row.source : "", "Source not specified");
        return "";
    }

    function rowSelected(row: var): bool {
        if (!row) return false;
        if (root.section === "docs")
            return root.textOf(row.path) === root.selectedDocPath;
        if (root.section === "memory")
            return root.textOf(row.slug) === root.selectedMemorySlug;
        if (root.section === "agents")
            return root.textOf(row.name) === root.selectedAgentName;
        return false;
    }

    function pick(row: var): void {
        if (!row) return;
        if (root.section === "docs") root.selectedDocPath = root.textOf(row.path);
        else if (root.section === "memory") root.selectedMemorySlug = root.textOf(row.slug);
        else if (root.section === "agents") root.selectedAgentName = root.textOf(row.name);
        if (root.narrow) root.narrowDetailOpen = true;
    }

    function ensureSelection(): void {
        if (root.section === "docs" && !root.selectedDoc)
            root.selectedDocPath = root.docs.length > 0 ? root.textOf(root.docs[0].path) : "";
        else if (root.section === "memory" && !root.selectedMemory)
            root.selectedMemorySlug = root.memory.length > 0 ? root.textOf(root.memory[0].slug) : "";
        else if (root.section === "agents" && !root.selectedAgent)
            root.selectedAgentName = root.agents.length > 0 ? root.textOf(root.agents[0].name) : "";
    }

    function resetForGhost(): void {
        root.docSearchText = "";
        root.selectedDocPath = "";
        root.selectedMemorySlug = "";
        root.selectedAgentName = "";
        root.narrowDetailOpen = false;
        root.characterPaneOpen = true;
    }

    function resetForSection(): void {
        root.docSearchText = "";
        root.narrowDetailOpen = false;
        root.characterPaneOpen = true;
        root.ensureSelection();
    }

    function sectionEmptyTitle(): string {
        if (Ghostd.activeGhost === "") return "No ghost selected";
        if (Ghostd.contextLoading) return "Loading context";
        if (Ghostd.contextError !== "") return "Context unavailable";
        if (root.section === "docs" && root.docQuery !== "") return "No matching documents";
        if (root.section === "docs") return "No documents found";
        if (root.section === "memory") return "No memories recorded";
        if (root.section === "agents") return "No wisps available";
        return "Context unavailable";
    }

    function sectionEmptyBody(): string {
        if (Ghostd.activeGhost === "") return "Choose a ghost before browsing its context.";
        if (Ghostd.contextLoading) return "Reading the ghost home and available wisps.";
        if (Ghostd.contextError !== "") return "Refresh to try reading the snapshot again.";
        if (root.section === "docs" && root.docQuery !== "")
            return "Try another title, path, or tag.";
        if (root.section === "docs") return "Markdown files under docs/ will appear here.";
        if (root.section === "memory") return "Recorded memories will appear here with their update time.";
        if (root.section === "agents") return "Wisps available from this ghost's directory will appear here.";
        return "This section could not be shown.";
    }

    onSectionChanged: Qt.callLater(root.resetForSection)
    onDocsChanged: root.ensureSelection()
    onMemoryChanged: root.ensureSelection()
    onAgentsChanged: root.ensureSelection()

    Component.onCompleted: {
        root.resetForSection();
        if (Ghostd.activeGhost !== "") Ghostd.fetchContext(false);
    }

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            root.resetForGhost();
            if (Ghostd.activeGhost !== "") Ghostd.fetchContext(false);
        }

        function onContextLoadingChanged(): void {
            if (!Ghostd.contextLoading) root.ensureSelection();
        }
    }

    // ---- Header -----------------------------------------------------------

    Rectangle {
        id: header
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        height: Theme.controlHeight + Theme.gap
        color: Theme.surface

        Row {
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.gap

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: root.sectionTitle()
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize + 1
                font.weight: Font.DemiBold
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: Ghostd.activeGhost === "" ? "" : "· " + Ghostd.activeGhost
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Text {
                anchors.verticalCenter: parent.verticalCenter
                visible: Ghostd.contextLoading
                text: "Reading…"
                color: Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
        }

        Rectangle {
            id: refreshButton
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            width: refreshLabel.implicitWidth + Theme.pad
            height: Theme.controlHeight
            radius: Theme.radius / 2
            color: refreshArea.containsMouse && refreshArea.enabled
                ? Theme.film(0.06) : "transparent"
            border.width: refreshButton.activeFocus ? 1 : 0
            border.color: Theme.amber(0.55)
            activeFocusOnTab: refreshArea.enabled

            Accessible.role: Accessible.Button
            Accessible.name: "Refresh context"

            Behavior on color {
                enabled: !Theme.reducedMotion
                ColorAnimation { duration: Theme.durFast }
            }

            Text {
                id: refreshLabel
                anchors.centerIn: parent
                text: Ghostd.contextLoading ? "Refreshing" : "Refresh"
                color: refreshArea.enabled
                    ? (refreshArea.containsMouse ? Theme.ghostAmber : Theme.foregroundDim)
                    : Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            MouseArea {
                id: refreshArea
                anchors.fill: parent
                enabled: Ghostd.activeGhost !== "" && !Ghostd.contextLoading
                hoverEnabled: true
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: Ghostd.fetchContext(true)
            }

            Keys.onPressed: event => {
                if (refreshArea.enabled && (event.key === Qt.Key_Return
                        || event.key === Qt.Key_Enter || event.key === Qt.Key_Space)) {
                    Ghostd.fetchContext(true);
                    event.accepted = true;
                }
            }
        }

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: Theme.border
        }
    }

    Rectangle {
        id: errorBanner
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        visible: Ghostd.contextError !== ""
        height: visible ? errorText.implicitHeight + Theme.gap * 2 : 0
        color: Theme.rose(0.08)

        Text {
            id: errorText
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            text: Ghostd.contextError
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }

        Rectangle {
            anchors.left: parent.left
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            height: 1
            color: Theme.rose(0.18)
        }
    }

    Item {
        id: body
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: errorBanner.bottom
        anchors.bottom: parent.bottom
        clip: true

        // ---- Left index --------------------------------------------------

        Rectangle {
            id: indexPane
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            visible: root.validSection && root.section !== "character"
                && (!root.narrow || !root.narrowDetailOpen)
            width: root.narrow ? parent.width : root.indexWidth
            color: Theme.surface

            Item {
                id: indexControls
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                height: root.section === "docs" && root.docs.length > 0
                    ? indexControlsColumn.implicitHeight + Theme.pad * 2 : 0

                Column {
                    id: indexControlsColumn
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad
                    anchors.verticalCenter: parent.verticalCenter

                    Rectangle {
                        visible: root.section === "docs" && root.docs.length > 0
                        width: parent.width
                        height: Theme.controlHeight
                        radius: Theme.radius / 2
                        color: searchInput.activeFocus ? Theme.film(0.10) : Theme.film(0.06)
                        border.width: searchInput.activeFocus ? 1 : 0
                        border.color: Theme.amber(0.45)

                        Behavior on color {
                            enabled: !Theme.reducedMotion
                            ColorAnimation { duration: Theme.durFast }
                        }

                        Text {
                            id: searchMark
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.gap
                            anchors.verticalCenter: parent.verticalCenter
                            text: "⌕"
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                        }

                        TextInput {
                            id: searchInput
                            anchors.left: searchMark.right
                            anchors.leftMargin: Theme.gap / 2
                            anchors.right: clearSearch.left
                            anchors.rightMargin: Theme.gap / 2
                            anchors.verticalCenter: parent.verticalCenter
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            selectByMouse: true
                            selectionColor: Theme.selection
                            clip: true
                            Accessible.name: "Search documents"

                            Keys.onEscapePressed: event => {
                                event.accepted = root.docSearchText !== "";
                                root.docSearchText = "";
                            }

                            Text {
                                anchors.left: parent.left
                                anchors.verticalCenter: parent.verticalCenter
                                visible: root.docSearchText === ""
                                text: "Search documents"
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }
                        }

                        Item {
                            id: clearSearch
                            anchors.right: parent.right
                            anchors.rightMargin: Theme.gap / 2
                            anchors.verticalCenter: parent.verticalCenter
                            width: root.docSearchText === "" ? 0 : Theme.controlHeight - Theme.pad
                            height: parent.height
                            visible: root.docSearchText !== ""

                            Text {
                                anchors.centerIn: parent
                                text: "×"
                                color: clearArea.containsMouse
                                    ? Theme.foreground : Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                            }

                            MouseArea {
                                id: clearArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.docSearchText = ""
                            }
                        }
                    }
                }

                Rectangle {
                    visible: indexControls.height > 0
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    height: 1
                    color: Theme.border
                }
            }

            Flickable {
                id: indexScroll
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: indexControls.bottom
                anchors.bottom: parent.bottom
                contentWidth: width
                contentHeight: indexContent.implicitHeight + Theme.pad * 2
                clip: true
                interactive: contentHeight > height
                boundsBehavior: Flickable.StopAtBounds

                Column {
                    id: indexContent
                    x: Theme.gap
                    y: Theme.gap
                    width: indexScroll.width - Theme.gap * 2
                    spacing: Theme.gap / 2

                    Repeater {
                        id: contextRows
                        model: root.sectionRows

                        Rectangle {
                            id: contextRow

                            required property var modelData
                            required property int index
                            readonly property bool selected: root.rowSelected(contextRow.modelData)

                            width: indexContent.width
                            height: rowCopy.implicitHeight + Theme.gap * 2
                            radius: Theme.radius / 2
                            color: contextRow.selected ? Theme.amber(0.11)
                                : (rowArea.containsMouse ? Theme.film(0.06) : "transparent")
                            border.width: contextRow.activeFocus ? 1 : 0
                            border.color: Theme.amber(0.50)
                            activeFocusOnTab: true

                            Accessible.role: Accessible.Button
                            Accessible.name: root.rowTitle(contextRow.modelData)
                            Accessible.description: root.rowSubtitle(contextRow.modelData)

                            Behavior on color {
                                enabled: !Theme.reducedMotion
                                ColorAnimation { duration: Theme.durFast }
                            }

                            Column {
                                id: rowCopy
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.gap
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.gap
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: Theme.gap / 2

                                Text {
                                    width: parent.width
                                    text: root.rowTitle(contextRow.modelData)
                                    color: contextRow.selected
                                        ? Theme.foregroundBright : Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    font.weight: contextRow.selected ? Font.DemiBold : Font.Normal
                                    elide: Text.ElideRight
                                }

                                Text {
                                    width: parent.width
                                    text: root.rowSubtitle(contextRow.modelData)
                                    color: Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    wrapMode: Text.WordWrap
                                    maximumLineCount: 2
                                    elide: Text.ElideRight
                                }

                                Text {
                                    visible: text !== ""
                                    width: parent.width
                                    text: root.rowMeta(contextRow.modelData)
                                    color: root.section === "docs"
                                            && contextRow.modelData.archived === true
                                        ? Theme.warn : Theme.foregroundFaint
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSizeSmall - 1
                                    elide: Text.ElideRight
                                }
                            }

                            MouseArea {
                                id: rowArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: {
                                    contextRow.forceActiveFocus();
                                    root.pick(contextRow.modelData);
                                }
                            }

                            Keys.onPressed: event => {
                                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space) {
                                    root.pick(contextRow.modelData);
                                    event.accepted = true;
                                }
                            }
                        }
                    }

                    Item {
                        visible: root.sectionRows.length === 0
                        width: indexContent.width
                        height: emptyIndexCopy.implicitHeight + Theme.sectionGap * 2

                        Column {
                            id: emptyIndexCopy
                            anchors.left: parent.left
                            anchors.right: parent.right
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: Theme.gap

                            Text {
                                width: parent.width
                                text: root.sectionEmptyTitle()
                                color: Ghostd.contextError !== "" ? Theme.danger : Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                                font.weight: Font.DemiBold
                                horizontalAlignment: Text.AlignHCenter
                                wrapMode: Text.WordWrap
                            }

                            Text {
                                width: parent.width
                                text: root.sectionEmptyBody()
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                horizontalAlignment: Text.AlignHCenter
                                wrapMode: Text.WordWrap
                            }
                        }
                    }

                    Text {
                        visible: root.skippedForSection.length > 0
                        width: indexContent.width
                        topPadding: Theme.gap
                        text: "Skipped"
                        color: Theme.warn
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall - 1
                        font.weight: Font.DemiBold
                        font.capitalization: Font.AllUppercase
                        font.letterSpacing: 1
                    }

                    Repeater {
                        model: root.skippedForSection

                        Rectangle {
                            required property var modelData
                            width: indexContent.width
                            height: skippedCopy.implicitHeight + Theme.gap * 2
                            radius: Theme.radius / 2
                            color: Theme.amber(0.06)

                            Column {
                                id: skippedCopy
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.gap
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.gap
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: Theme.gap / 2

                                Text {
                                    width: parent.width
                                    text: root.valueOr(parent.parent.modelData.path, "Unknown path")
                                    color: Theme.warn
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSizeSmall
                                    elide: Text.ElideMiddle
                                }

                                Text {
                                    width: parent.width
                                    text: root.valueOr(parent.parent.modelData.reason, "Could not read this entry")
                                    color: Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall - 1
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }
                    }
                }
            }

            Rectangle {
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: 1
                color: Theme.border
            }
        }

        // ---- Detail ------------------------------------------------------

        Item {
            id: detailPane
            anchors.top: parent.top
            anchors.right: parent.right
            anchors.bottom: parent.bottom
            anchors.left: root.validSection && root.section !== "character"
                    && !root.narrow ? indexPane.right : parent.left
            visible: root.validSection && (root.section === "character"
                || !root.narrow || root.narrowDetailOpen)

            Rectangle {
                id: backBar
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                visible: root.narrow && root.section !== "character"
                height: visible ? Theme.controlHeight + Theme.gap : 0
                color: Theme.surface

                Rectangle {
                    id: backButton
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    width: backLabel.implicitWidth + Theme.pad
                    height: Theme.controlHeight
                    radius: Theme.radius / 2
                    color: backArea.containsMouse ? Theme.film(0.06) : "transparent"
                    border.width: backButton.activeFocus ? 1 : 0
                    border.color: Theme.amber(0.55)
                    activeFocusOnTab: true

                    Accessible.role: Accessible.Button
                    Accessible.name: "Back to " + root.sectionTitle()

                    Text {
                        id: backLabel
                        anchors.centerIn: parent
                        text: "‹ Back to " + root.sectionTitle()
                        color: backArea.containsMouse
                            ? Theme.ghostAmberBright : Theme.ghostAmber
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                    }

                    MouseArea {
                        id: backArea
                        anchors.fill: parent
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.narrowDetailOpen = false
                    }

                    Keys.onPressed: event => {
                        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                || event.key === Qt.Key_Space) {
                            root.narrowDetailOpen = false;
                            event.accepted = true;
                        }
                    }
                }

                Rectangle {
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.bottom: parent.bottom
                    height: 1
                    color: Theme.border
                }
            }

            Item {
                id: detailBody
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: backBar.bottom
                anchors.bottom: parent.bottom
                clip: true

                FilePane {
                    id: fileEditor
                    anchors.fill: parent
                    visible: root.editorVisible
                    enabled: visible
                    filePath: root.editorAbsolutePath

                    onClosed: {
                        if (root.section === "docs") {
                            root.selectedDocPath = "";
                            if (root.narrow) root.narrowDetailOpen = false;
                        } else if (root.section === "character") {
                            root.characterPaneOpen = false;
                        }
                    }
                }

                Item {
                    id: memoryDetail
                    anchors.fill: parent
                    visible: root.section === "memory" && root.selectedMemory !== null

                    Column {
                        id: memoryHeader
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.pad
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.pad
                        anchors.top: parent.top
                        anchors.topMargin: Theme.pad
                        spacing: Theme.gap

                        Text {
                            width: parent.width
                            text: root.selectedMemory ? root.memoryTitle(root.selectedMemory) : ""
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize + 1
                            font.weight: Font.DemiBold
                            elide: Text.ElideRight
                        }

                        Text {
                            width: parent.width
                            text: root.selectedMemory
                                ? root.valueOr(root.selectedMemory.description, "No description") : ""
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            wrapMode: Text.WordWrap
                        }

                        Text {
                            width: parent.width
                            text: root.selectedMemory ? root.rowMeta(root.selectedMemory) : ""
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            elide: Text.ElideRight
                        }
                    }

                    Rectangle {
                        id: memoryRule
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: memoryHeader.bottom
                        anchors.topMargin: Theme.pad
                        height: 1
                        color: Theme.border
                    }

                    Flickable {
                        id: memoryScroll
                        anchors.left: parent.left
                        anchors.right: parent.right
                        anchors.top: memoryRule.bottom
                        anchors.bottom: parent.bottom
                        contentWidth: width
                        contentHeight: Math.max(height,
                            memoryText.contentHeight + Theme.pad * 2)
                        clip: true
                        interactive: contentHeight > height
                        boundsBehavior: Flickable.StopAtBounds

                        TextEdit {
                            id: memoryText
                            x: Theme.pad
                            y: Theme.pad
                            width: memoryScroll.width - Theme.pad * 2
                            height: Math.max(contentHeight, memoryScroll.height - Theme.pad * 2)
                            readOnly: true
                            selectByMouse: true
                            text: root.selectedMemory
                                ? root.textOf(root.selectedMemory.content) : ""
                            textFormat: TextEdit.PlainText
                            wrapMode: TextEdit.Wrap
                            color: Theme.foreground
                            selectionColor: Theme.selection
                            selectedTextColor: Theme.foregroundBright
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSize
                        }
                    }
                }

                Flickable {
                    id: agentScroll
                    anchors.fill: parent
                    visible: root.section === "agents" && root.selectedAgent !== null
                    contentWidth: width
                    contentHeight: Math.max(height, agentCopy.implicitHeight + Theme.pad * 2)
                    clip: true
                    interactive: contentHeight > height
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: agentCopy
                        x: Theme.pad
                        y: Theme.pad
                        width: agentScroll.width - Theme.pad * 2
                        spacing: Theme.sectionGap

                        Column {
                            width: parent.width
                            spacing: Theme.gap

                            Text {
                                width: parent.width
                                text: root.selectedAgent
                                    ? root.valueOr(root.selectedAgent.name, "Unnamed wisp") : ""
                                color: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize + 1
                                font.weight: Font.DemiBold
                                elide: Text.ElideRight
                            }

                            Text {
                                width: parent.width
                                text: root.selectedAgent
                                    ? root.valueOr(root.selectedAgent.description, "No description") : ""
                                color: Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                                wrapMode: Text.WordWrap
                                lineHeight: Theme.lineHeight
                            }
                        }

                        Repeater {
                            model: root.agentFields

                            Column {
                                required property var modelData
                                width: agentCopy.width
                                spacing: Theme.gap / 2

                                Text {
                                    width: parent.width
                                    text: parent.modelData.label
                                    color: Theme.foregroundFaint
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall - 1
                                    font.weight: Font.DemiBold
                                    font.capitalization: Font.AllUppercase
                                    font.letterSpacing: 1
                                }

                                Text {
                                    width: parent.width
                                    text: parent.modelData.value
                                    color: Theme.foreground
                                    font.family: parent.modelData.label === "Source"
                                        ? Theme.fontFamilyMono : Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }


                    }
                }

                Item {
                    id: detailState
                    anchors.fill: parent
                    visible: !root.editorVisible
                        && !(root.section === "memory" && root.selectedMemory)
                        && !(root.section === "agents" && root.selectedAgent)

                    Column {
                        anchors.centerIn: parent
                        width: Math.min(parent.width - Theme.pad * 2, Theme.pad * 24)
                        spacing: Theme.gap

                        Text {
                            width: parent.width
                            text: {
                                if (!root.validSection) return "Unknown context section";
                                if (Ghostd.activeGhost === "") return "No ghost selected";
                                if (Ghostd.contextLoading) return "Loading context";
                                if (root.section === "character" && !root.characterPaneOpen)
                                    return "Character editor closed";
                                if (root.section === "character") return "Character unavailable";
                                if (root.section === "docs") return "Choose a document";
                                if (root.section === "memory") return "Choose a memory";
                                if (root.section === "agents") return "Choose a wisp";
                                return "Context unavailable";
                            }
                            color: Ghostd.contextError !== "" ? Theme.danger : Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize + 1
                            font.weight: Font.DemiBold
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                        }

                        Text {
                            width: parent.width
                            text: {
                                if (!root.validSection) return "Use Docs, Memory, Wisps, or Character.";
                                if (Ghostd.activeGhost === "")
                                    return "Choose a ghost before browsing its context.";
                                if (Ghostd.contextLoading) return "Reading the ghost home.";
                                if (root.section === "character" && !root.characterPaneOpen)
                                    return "Open character.md when you are ready to continue.";
                                if (root.section === "character" && root.character
                                        && root.editorAbsolutePath === "")
                                    return "The ghost home is still resolving.";
                                if (Ghostd.contextError !== "") return "Refresh to try again.";
                                return "Select an entry from the index.";
                            }
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                        }

                        Rectangle {
                            id: reopenButton
                            anchors.horizontalCenter: parent.horizontalCenter
                            visible: root.section === "character" && !root.characterPaneOpen
                                && root.character !== null
                            width: reopenLabel.implicitWidth + Theme.pad * 2
                            height: Theme.controlHeight
                            radius: Theme.radius / 2
                            color: reopenArea.containsMouse
                                ? Theme.amber(0.15) : Theme.amber(0.10)
                            border.width: reopenButton.activeFocus ? 1 : 0
                            border.color: Theme.amber(0.50)
                            activeFocusOnTab: visible

                            Accessible.role: Accessible.Button
                            Accessible.name: "Open character"

                            Text {
                                id: reopenLabel
                                anchors.centerIn: parent
                                text: "Open character"
                                color: Theme.ghostAmber
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }

                            MouseArea {
                                id: reopenArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: root.characterPaneOpen = true
                            }

                            Keys.onPressed: event => {
                                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space) {
                                    root.characterPaneOpen = true;
                                    event.accepted = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
