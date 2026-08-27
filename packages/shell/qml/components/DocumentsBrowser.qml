pragma ComponentBehavior: Bound

// Shared, XDG Documents browser. Its three-column shape follows Apple Notes'
// folder/list/detail hierarchy, while its colours and density are
// Ghost's. Every daemon page is one directory deep; expansion is the only act
// that discovers another level.
import QtQuick
import qs.services
import "DocumentModel.js" as Documents

Rectangle {
    id: root

    property string selectedFolder: ""
    property var expandedFolders: Documents.setMapValue(Documents.emptyMap(), "", true)
    property var selections: Documents.emptyMap()
    property var listScrolls: Documents.emptyMap()
    property string compactStage: "folders" // folders, files, detail
    property string pendingDeletePath: ""
    property string pendingDeleteName: ""
    property bool deleteClosedFile: false
    property alias searchText: searchInput.text

    readonly property bool wide: root.width >= 790
    readonly property string query: Documents.normalizedQuery(root.searchText)
    readonly property var directory: Ghostd.documentSnapshot(root.selectedFolder, root.query)
    readonly property var unfilteredDirectory:
        Ghostd.documentSnapshot(root.selectedFolder, "")
    readonly property var folderRows:
        Documents.visibleFolders(Ghostd.documentDirectories, root.expandedFolders)
    readonly property var entries: root.query === ""
        ? root.directory.entries.filter(function (entry) { return entry.kind === "file"; })
        : root.directory.entries
    readonly property string selectionKey: Documents.key(root.selectedFolder, root.query)
    readonly property string selectedPath:
        String(Documents.mapValue(root.selections, root.selectionKey, ""))
    readonly property var selectedEntry: root.findEntry(root.directory.entries, root.selectedPath)
    readonly property string selectedAbsolutePath: root.absolutePath(root.selectedPath)
    readonly property bool selectedInlineSizeAllowed: Documents.canReadInline(root.selectedEntry)
    readonly property bool selectedTooLarge: Documents.isTooLargeForInline(root.selectedEntry)
    readonly property bool selectedSizeKnown: root.selectedEntry !== null
        && Number.isSafeInteger(root.selectedEntry.size) && root.selectedEntry.size >= 0
    readonly property bool selectedTypeSupported: root.selectedEntry !== null
        && root.selectedEntry.kind === "file" && Workbench.canOpen(root.selectedAbsolutePath)
    readonly property bool selectedContentEligible: root.selectedEntry !== null
        && root.selectedEntry.kind === "file" && root.selectedInlineSizeAllowed
        && root.selectedTypeSupported
    readonly property bool selectedOpenable: root.selectedContentEligible
        && Ghostd.documentContentPath === root.selectedPath
        && Ghostd.documentContentReady && !Ghostd.documentContentLoading
        && Ghostd.documentContentError === ""
    readonly property bool inlineEditorLoaded: root.selectedOpenable
    readonly property string selectedInlineReason: {
        if (root.selectedTooLarge)
            return "Too large to open inline. Ghost reads files up to 1 MB here.";
        if (!root.selectedSizeKnown)
            return "Size unavailable. Ghost will not read this file inline without a safe size.";
        if (root.selectedContentEligible && Ghostd.documentContentLoading)
            return "Reading this file safely through ghostd…";
        if (root.selectedContentEligible && Ghostd.documentContentError !== "")
            return Ghostd.documentContentError;
        return "Ghost does not render this file type, but your desktop may open it.";
    }
    readonly property var crumbs: Documents.breadcrumbs(root.selectedFolder)
    readonly property int folderPaneWidth: 190
    readonly property int listPaneWidth: 270

    // Test/preview seams that expose the adaptive state without reaching into
    // visual delegates.
    readonly property int visibleFolderCount: root.folderRows.length
    readonly property int visibleEntryCount: root.entries.length
    readonly property bool searchFocused: searchInput.activeFocus

    implicitWidth: Theme.pad * 50
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true
    activeFocusOnTab: true

    function absolutePath(path: string): string {
        const base = String(Ghostd.documentsRoot || "").replace(/\/+$/u, "");
        const relative = Documents.normalizePath(path);
        return base === "" || relative === "" ? "" : base + "/" + relative;
    }

    function findEntry(entries: var, path: string): var {
        for (const entry of entries || []) {
            if (entry && entry.path === path) return entry;
        }
        return null;
    }

    function setSelection(path: string): void {
        root.selections = Documents.setMapValue(root.selections, root.selectionKey, path);
    }

    function saveListScroll(): void {
        root.listScrolls = Documents.setMapValue(root.listScrolls,
            root.selectionKey, fileList.contentY);
    }

    function restoreListScroll(): void {
        const wanted = Number(Documents.mapValue(root.listScrolls,
            root.selectionKey, Number.NaN));
        fileList.contentY = Number.isFinite(wanted)
            ? Math.max(fileList.originY, wanted) : fileList.originY;
    }

    function ensureSelection(): void {
        if (root.selectedEntry && root.selectedEntry.kind === "file") return;
        const first = root.entries.find(function (entry) { return entry.kind === "file"; });
        root.setSelection(first ? first.path : "");
    }

    function setExpanded(path: string, expanded: bool): void {
        root.expandedFolders = Documents.setMapValue(root.expandedFolders, path, expanded);
    }

    function toggleFolder(row: var): void {
        if (!row) return;
        if (row.more) {
            Ghostd.loadMoreDocuments(row.ownerPath, "");
            return;
        }
        if (row.expanded) {
            root.setExpanded(row.path, false);
            return;
        }
        root.setExpanded(row.path, true);
        Ghostd.fetchDocuments(row.path, "", false, false);
    }

    function chooseFolder(path: string, advance: bool): void {
        root.saveListScroll();
        root.selectedFolder = Documents.normalizePath(path);
        root.searchText = "";
        root.setExpanded(root.selectedFolder, true);
        Ghostd.fetchDocuments(root.selectedFolder, "", false, false);
        if (!root.wide && advance) root.compactStage = "files";
        Qt.callLater(function () {
            root.ensureSelection();
            root.restoreListScroll();
        });
    }

    function chooseEntry(entry: var): void {
        if (!entry) return;
        if (entry.kind === "directory") {
            root.chooseFolder(entry.path, true);
            return;
        }
        root.setSelection(entry.path);
        if (!root.wide) root.compactStage = "detail";
    }

    function goToParent(): void {
        root.chooseFolder(Documents.parent(root.selectedFolder), false);
    }

    function formatSize(value: var): string {
        const bytes = Number(value);
        if (!Number.isFinite(bytes) || bytes < 0) return "Size unavailable";
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
        if (bytes < 1024 * 1024 * 1024)
            return (bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MB";
        return (bytes / (1024 * 1024 * 1024)).toFixed(1) + " GB";
    }

    function formatDate(value: var): string {
        const raw = String(value || "");
        if (raw === "") return "Modified time unavailable";
        const date = new Date(raw);
        return Number.isNaN(date.getTime()) ? raw : Qt.formatDateTime(date, "MMM d, yyyy · h:mm AP");
    }

    function requestDelete(entry: var): void {
        if (!entry || entry.kind !== "file" || Ghostd.documentDeletingPath !== "") return;
        Ghostd.documentDeleteError = "";
        root.pendingDeletePath = entry.path;
        root.pendingDeleteName = entry.name;
        root.deleteClosedFile = false;
    }

    function confirmDelete(): void {
        if (root.pendingDeletePath === "" || Ghostd.documentDeletingPath !== "") return;
        if (root.selectedPath === root.pendingDeletePath && root.selectedOpenable)
            root.deleteClosedFile = true;
        Ghostd.deleteDocument(root.pendingDeletePath);
    }

    function dismissDelete(): void {
        if (Ghostd.documentDeletingPath !== "") return;
        root.pendingDeletePath = "";
        root.pendingDeleteName = "";
        root.deleteClosedFile = false;
        Ghostd.documentDeleteError = "";
    }

    function settleDelete(path: string): void {
        if (root.selectedPath === path || root.deleteClosedFile)
            root.setSelection(Documents.nextFile(root.directory.entries, path));
        root.dismissDelete();
        if (!root.wide && root.selectedPath === "") root.compactStage = "files";
    }

    onSelectedFolderChanged: Qt.callLater(root.restoreListScroll)
    function requestSelectedContent(): void {
        if (root.selectedContentEligible)
            Ghostd.fetchDocumentContent(root.selectedPath, false);
        else Ghostd.clearDocumentContent();
    }

    // `selectedPath` and `selectedEntry` are bindings over the same immutable
    // selection-map replacement; wait one turn so both have settled before
    // deciding whether the daemon content route is eligible.
    onSelectedPathChanged: Qt.callLater(root.requestSelectedContent)
    onSelectedEntryChanged: Qt.callLater(root.requestSelectedContent)
    onQueryChanged: {
        queryDelay.restart();
        Qt.callLater(root.restoreListScroll);
    }
    onWideChanged: if (root.wide) root.compactStage = "files"

    Component.onCompleted: {
        Ghostd.fetchDocuments("", "", false, false);
        root.setExpanded("", true);
    }

    Connections {
        target: Ghostd

        function onDocumentDirectoryChanged(path: string, query: string): void {
            if (path !== root.selectedFolder || query !== root.query) return;
            root.ensureSelection();
            Qt.callLater(root.restoreListScroll);
        }

        function onDocumentDeleteFinished(path: string, ok: bool): void {
            if (ok && path === root.pendingDeletePath) root.settleDelete(path);
        }

        function onDocumentsConnectionReset(_epoch: int): void {
            root.selectedFolder = "";
            root.searchText = "";
            root.expandedFolders = Documents.setMapValue(Documents.emptyMap(), "", true);
            root.selections = Documents.emptyMap();
            root.listScrolls = Documents.emptyMap();
            root.compactStage = "folders";
        }
    }

    Timer {
        id: queryDelay
        interval: 180
        repeat: false
        onTriggered: Ghostd.fetchDocuments(root.selectedFolder, root.query, false, false)
    }

    Keys.onPressed: event => {
        if ((event.modifiers & Qt.ControlModifier) && event.key === Qt.Key_F) {
            if (!root.wide) root.compactStage = "files";
            searchInput.forceActiveFocus();
            event.accepted = true;
        } else if (event.key === Qt.Key_Escape && !root.wide) {
            if (root.compactStage === "detail") root.compactStage = "files";
            else if (root.compactStage === "files") root.compactStage = "folders";
            else return;
            event.accepted = true;
        }
    }

    Shortcut {
        sequences: [StandardKey.Find]
        context: Qt.WindowShortcut
        onActivated: {
            if (!root.wide) root.compactStage = "files";
            searchInput.forceActiveFocus();
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

        Column {
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            spacing: 1

            Text {
                text: "Documents"
                color: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize + 1
                font.weight: Font.DemiBold
            }
            Text {
                text: "Shared on this machine"
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall - 1
            }
        }

        Rectangle {
            id: refreshButton
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            width: refreshText.implicitWidth + Theme.pad
            height: Theme.controlHeight
            radius: Theme.radius / 2
            color: refreshArea.containsMouse ? Theme.film(0.06) : "transparent"
            border.width: activeFocus ? 1 : 0
            border.color: Theme.amber(0.55)
            activeFocusOnTab: true
            Accessible.role: Accessible.Button
            Accessible.name: "Refresh current Documents folder"

            Text {
                id: refreshText
                anchors.centerIn: parent
                text: root.directory.loading ? "Refreshing" : "Refresh"
                color: root.directory.loading ? Theme.foregroundFaint : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
            MouseArea {
                id: refreshArea
                anchors.fill: parent
                enabled: !root.directory.loading
                hoverEnabled: true
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: Ghostd.refreshDocuments(root.selectedFolder, root.query)
            }
            Keys.onPressed: event => {
                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                        || event.key === Qt.Key_Space) && !root.directory.loading) {
                    Ghostd.refreshDocuments(root.selectedFolder, root.query);
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
        id: body
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.bottom: parent.bottom
        clip: true

        // ---- Folder tree --------------------------------------------------

        Rectangle {
            id: folderPane
            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: root.wide ? root.folderPaneWidth : parent.width
            visible: root.wide || root.compactStage === "folders"
            color: Theme.surface
            clip: true

            Text {
                id: foldersHeading
                anchors.left: parent.left
                anchors.leftMargin: Theme.pad
                anchors.top: parent.top
                anchors.topMargin: Theme.pad
                text: "FOLDERS"
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall - 1
                font.weight: Font.DemiBold
                font.capitalization: Font.AllUppercase
                font.letterSpacing: 1
            }

            ListView {
                id: folderList
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: foldersHeading.bottom
                anchors.topMargin: Theme.gap
                anchors.bottom: parent.bottom
                clip: true
                model: root.folderRows
                spacing: 2
                boundsBehavior: Flickable.StopAtBounds
                keyNavigationEnabled: true
                reuseItems: true
                cacheBuffer: 240
                contentWidth: Math.max(width,
                    Documents.maxDepth(root.folderRows) * 14 + root.folderPaneWidth)
                flickableDirection: Flickable.AutoFlickDirection

                delegate: Rectangle {
                    id: folderRow
                    required property var modelData
                    required property int index
                    readonly property bool selected: !folderRow.modelData.more
                        && folderRow.modelData.path === root.selectedFolder
                    width: folderList.contentWidth
                    height: Theme.controlHeight
                    color: folderRow.selected ? Theme.amber(0.11)
                        : (folderMouse.containsMouse ? Theme.film(0.06) : "transparent")
                    border.width: activeFocus ? 1 : 0
                    border.color: Theme.amber(0.50)
                    activeFocusOnTab: true

                    Accessible.role: Accessible.TreeItem
                    Accessible.name: folderRow.modelData.more
                        ? folderRow.modelData.name
                        : folderRow.modelData.name + (folderRow.modelData.loaded
                            ? ", " + folderRow.modelData.fileCount + " files" : "")
                    Accessible.description: folderRow.modelData.more
                        ? "Load the next directory page"
                        : (folderRow.modelData.path === "" ? "Documents root"
                            : folderRow.modelData.path)

                    Row {
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.gap + folderRow.modelData.depth * 14
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: Theme.gap / 2

                        Text {
                            id: disclosure
                            width: 14
                            text: folderRow.modelData.more ? "…"
                                : (folderRow.modelData.loading ? "◌"
                                    : (folderRow.modelData.expanded ? "⌄" : "›"))
                            color: folderRow.modelData.error !== ""
                                ? Theme.danger : Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            horizontalAlignment: Text.AlignHCenter
                        }
                        Text {
                            text: folderRow.modelData.more ? "More…" : "▱"
                            color: folderRow.selected ? Theme.ghostAmber : Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                        }
                        Text {
                            width: Math.max(30, parent.width - x
                                - folderCount.implicitWidth - Theme.gap)
                            text: folderRow.modelData.name
                            color: folderRow.modelData.error !== ""
                                ? Theme.danger
                                : (folderRow.selected ? Theme.foregroundBright : Theme.foreground)
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            font.weight: folderRow.selected ? Font.DemiBold : Font.Normal
                            elide: Text.ElideRight
                        }
                        Text {
                            id: folderCount
                            visible: !folderRow.modelData.more && folderRow.modelData.loaded
                            text: folderRow.modelData.fileCount
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                        }
                    }

                    MouseArea {
                        id: disclosureMouse
                        x: Theme.gap + folderRow.modelData.depth * 14
                        width: 30
                        anchors.top: parent.top
                        anchors.bottom: parent.bottom
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: root.toggleFolder(folderRow.modelData)
                    }
                    MouseArea {
                        id: folderMouse
                        anchors.left: disclosureMouse.right
                        anchors.right: parent.right
                        anchors.top: parent.top
                        anchors.bottom: parent.bottom
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            folderRow.forceActiveFocus();
                            if (folderRow.modelData.more) root.toggleFolder(folderRow.modelData);
                            else root.chooseFolder(folderRow.modelData.path, true);
                        }
                    }
                    Keys.onPressed: event => {
                        if (event.key === Qt.Key_Right) {
                            if (!folderRow.modelData.more && !folderRow.modelData.expanded)
                                root.toggleFolder(folderRow.modelData);
                            event.accepted = true;
                        } else if (event.key === Qt.Key_Left) {
                            if (!folderRow.modelData.more && folderRow.modelData.expanded)
                                root.toggleFolder(folderRow.modelData);
                            else if (!folderRow.modelData.more)
                                root.chooseFolder(Documents.parent(folderRow.modelData.path), false);
                            event.accepted = true;
                        } else if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                || event.key === Qt.Key_Space) {
                            if (folderRow.modelData.more) root.toggleFolder(folderRow.modelData);
                            else root.chooseFolder(folderRow.modelData.path, true);
                            event.accepted = true;
                        }
                    }
                }
            }

            Rectangle {
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: root.wide ? 1 : 0
                color: Theme.border
            }
        }

        // ---- Direct-file list --------------------------------------------

        Rectangle {
            id: listPane
            anchors.left: root.wide ? folderPane.right : parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: root.wide ? root.listPaneWidth : parent.width
            visible: root.wide || root.compactStage === "files"
            color: Theme.background
            clip: true

            Rectangle {
                id: compactFilesBack
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                visible: !root.wide
                height: visible ? Theme.controlHeight : 0
                color: Theme.surface
                activeFocusOnTab: visible
                Accessible.role: Accessible.Button
                Accessible.name: "Back to Documents folders"

                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad
                    anchors.verticalCenter: parent.verticalCenter
                    text: "‹ Folders"
                    color: backToFolders.containsMouse ? Theme.ghostAmberBright : Theme.ghostAmber
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }
                MouseArea {
                    id: backToFolders
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.compactStage = "folders"
                }
                Keys.onPressed: event => {
                    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                            || event.key === Qt.Key_Space) {
                        root.compactStage = "folders";
                        event.accepted = true;
                    }
                }
            }

            Item {
                id: listControls
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: compactFilesBack.bottom
                height: crumbsRow.height + searchBox.height + Theme.pad * 2 + Theme.gap

                Flickable {
                    id: crumbsScroll
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad
                    anchors.top: parent.top
                    anchors.topMargin: Theme.gap
                    height: Theme.controlHeight - Theme.gap
                    contentWidth: crumbsRow.implicitWidth
                    contentHeight: height
                    clip: true
                    flickableDirection: Flickable.HorizontalFlick

                    Row {
                        id: crumbsRow
                        height: parent.height
                        spacing: Theme.gap / 2

                        Repeater {
                            model: root.crumbs
                            Row {
                                id: crumb
                                required property var modelData
                                required property int index
                                spacing: Theme.gap / 2
                                Text {
                                    visible: parent.index > 0
                                    text: "›"
                                    color: Theme.foregroundFaint
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                }
                                Text {
                                    text: parent.modelData.name
                                    color: crumbMouse.containsMouse
                                        ? Theme.ghostAmber : Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: parent.index === root.crumbs.length - 1
                                        ? Font.DemiBold : Font.Normal
                                    activeFocusOnTab: true
                                    Accessible.role: Accessible.Button
                                    Accessible.name: "Open " + parent.modelData.name
                                    MouseArea {
                                        id: crumbMouse
                                        anchors.fill: parent
                                        anchors.margins: -Theme.gap / 4
                                        hoverEnabled: true
                                        cursorShape: Qt.PointingHandCursor
                                        onClicked: root.chooseFolder(crumb.modelData.path, false)
                                    }
                                    Keys.onPressed: event => {
                                        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                                || event.key === Qt.Key_Space) {
                                            root.chooseFolder(crumb.modelData.path, false);
                                            event.accepted = true;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }

                Rectangle {
                    id: searchBox
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad
                    anchors.top: crumbsScroll.bottom
                    anchors.topMargin: Theme.gap
                    height: Theme.controlHeight
                    radius: Theme.radius / 2
                    color: searchInput.activeFocus ? Theme.film(0.10) : Theme.film(0.06)
                    border.width: searchInput.activeFocus ? 1 : 0
                    border.color: Theme.amber(0.45)

                    Text {
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
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.pad + Theme.gap
                        anchors.right: clearSearch.left
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        selectByMouse: true
                        selectionColor: Theme.selection
                        clip: true
                        activeFocusOnTab: true
                        Accessible.name: "Search current Documents folder"
                        Keys.onEscapePressed: event => {
                            event.accepted = root.searchText !== "";
                            root.searchText = "";
                        }
                        Text {
                            anchors.left: parent.left
                            anchors.verticalCenter: parent.verticalCenter
                            visible: root.searchText === ""
                            text: "Search this folder"
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }
                    }
                    Text {
                        id: clearSearch
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        visible: root.searchText !== ""
                        activeFocusOnTab: visible
                        text: "×"
                        color: clearSearchMouse.containsMouse
                            ? Theme.foreground : Theme.foregroundFaint
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        Accessible.role: Accessible.Button
                        Accessible.name: "Clear Documents search"
                        MouseArea {
                            id: clearSearchMouse
                            anchors.fill: parent
                            anchors.margins: -Theme.gap / 2
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.searchText = ""
                        }
                        Keys.onPressed: event => {
                            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                    || event.key === Qt.Key_Space) {
                                root.searchText = "";
                                event.accepted = true;
                            }
                        }
                    }
                }
            }

            Rectangle {
                id: listError
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: listControls.bottom
                visible: root.directory.error !== ""
                height: visible ? errorColumn.implicitHeight + Theme.gap * 2 : 0
                color: Theme.rose(0.08)
                Column {
                    id: errorColumn
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.gap
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 2
                    Text {
                        width: parent.width
                        text: root.directory.error
                        color: Theme.danger
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }
                    Text {
                        id: retryButton
                        text: root.directory.cursorStale ? "Refresh this folder" : "Retry"
                        color: retryMouse.containsMouse ? Theme.ghostAmberBright : Theme.ghostAmber
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        activeFocusOnTab: visible
                        Accessible.role: Accessible.Button
                        Accessible.name: text
                        MouseArea {
                            id: retryMouse
                            anchors.fill: parent
                            anchors.margins: -2
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Ghostd.refreshDocuments(root.selectedFolder, root.query)
                        }
                        Keys.onPressed: event => {
                            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                    || event.key === Qt.Key_Space) {
                                Ghostd.refreshDocuments(root.selectedFolder, root.query);
                                event.accepted = true;
                            }
                        }
                    }
                }
            }

            ListView {
                id: fileList
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: listError.bottom
                anchors.bottom: parent.bottom
                clip: true
                model: root.entries
                spacing: Theme.gap / 2
                topMargin: Theme.gap
                bottomMargin: Theme.gap
                leftMargin: Theme.gap
                rightMargin: Theme.gap
                boundsBehavior: Flickable.StopAtBounds
                keyNavigationEnabled: true
                reuseItems: true
                cacheBuffer: 360
                onMovementEnded: root.saveListScroll()

                delegate: Rectangle {
                    id: fileRow
                    required property var modelData
                    required property int index
                    readonly property bool selected: fileRow.modelData.path === root.selectedPath
                    width: fileList.width - fileList.leftMargin - fileList.rightMargin
                    height: Theme.controlHeight + Theme.pad
                    radius: Theme.radius / 2
                    color: fileRow.selected ? Theme.amber(0.11)
                        : (fileMouse.containsMouse ? Theme.film(0.06) : "transparent")
                    border.width: activeFocus ? 1 : 0
                    border.color: Theme.amber(0.50)
                    activeFocusOnTab: true
                    Accessible.role: Accessible.ListItem
                    Accessible.name: fileRow.modelData.name
                    Accessible.description: fileRow.modelData.kind === "directory"
                        ? "Folder " + fileRow.modelData.path
                        : root.formatDate(fileRow.modelData.modifiedAt)
                    Accessible.selected: fileRow.selected

                    Column {
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.gap
                        anchors.right: deleteButton.left
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 2
                        Text {
                            width: parent.width
                            text: (fileRow.modelData.kind === "directory" ? "▱  " : "")
                                + fileRow.modelData.name
                            color: fileRow.selected ? Theme.foregroundBright : Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            font.weight: fileRow.selected ? Font.DemiBold : Font.Normal
                            elide: Text.ElideRight
                        }
                        Text {
                            objectName: "documentsEmptyTitle"
                            width: parent.width
                            text: fileRow.modelData.kind === "directory"
                                ? "Folder"
                                : root.formatDate(fileRow.modelData.modifiedAt)
                                    + " · " + root.formatSize(fileRow.modelData.size)
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            elide: Text.ElideRight
                        }
                    }
                    Rectangle {
                        id: deleteButton
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.gap / 2
                        anchors.verticalCenter: parent.verticalCenter
                        visible: fileRow.modelData.kind === "file"
                        width: visible ? Theme.controlHeight - Theme.gap : 0
                        height: width
                        radius: Theme.radius / 2
                        color: deleteMouse.containsMouse ? Theme.rose(0.12) : "transparent"
                        border.width: activeFocus ? 1 : 0
                        border.color: Theme.rose(0.42)
                        activeFocusOnTab: visible
                        z: 2
                        Accessible.role: Accessible.Button
                        Accessible.name: "Delete " + fileRow.modelData.name
                        Text {
                            anchors.centerIn: parent
                            text: "×"
                            color: deleteMouse.containsMouse ? Theme.danger : Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                        }
                        MouseArea {
                            id: deleteMouse
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: root.requestDelete(fileRow.modelData)
                        }
                        Keys.onPressed: event => {
                            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                    || event.key === Qt.Key_Space)
                                    && Ghostd.documentDeletingPath === "") {
                                root.requestDelete(fileRow.modelData);
                                event.accepted = true;
                            }
                        }
                    }
                    MouseArea {
                        id: fileMouse
                        anchors.fill: parent
                        z: 1
                        hoverEnabled: true
                        cursorShape: Qt.PointingHandCursor
                        onClicked: {
                            fileRow.forceActiveFocus();
                            root.chooseEntry(fileRow.modelData);
                        }
                    }
                    Keys.onPressed: event => {
                        if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                || event.key === Qt.Key_Space) {
                            root.chooseEntry(fileRow.modelData);
                            event.accepted = true;
                        } else if (event.key === Qt.Key_Delete
                                && fileRow.modelData.kind === "file") {
                            root.requestDelete(fileRow.modelData);
                            event.accepted = true;
                        }
                    }
                }

                footer: Column {
                    width: fileList.width - fileList.leftMargin - fileList.rightMargin
                    spacing: Theme.gap
                    Item {
                        width: parent.width
                        height: root.directory.nextCursor !== "" ? Theme.controlHeight + Theme.gap : 0
                        visible: height > 0
                        Rectangle {
                            id: loadMoreButton
                            anchors.centerIn: parent
                            width: loadMoreLabel.implicitWidth + Theme.pad * 2
                            height: Theme.controlHeight
                            radius: Theme.radius / 2
                            color: loadMoreMouse.containsMouse ? Theme.amber(0.12) : Theme.film(0.05)
                            border.width: activeFocus ? 1 : 0
                            border.color: Theme.amber(0.45)
                            activeFocusOnTab: visible && !root.directory.loading
                            Accessible.role: Accessible.Button
                            Accessible.name: "Load more items from this Documents folder"
                            Text {
                                id: loadMoreLabel
                                anchors.centerIn: parent
                                text: root.directory.loading ? "Loading…"
                                    : "Load " + Math.min(100,
                                        root.directory.total - root.directory.entries.length) + " more"
                                color: Theme.ghostAmber
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }
                            MouseArea {
                                id: loadMoreMouse
                                anchors.fill: parent
                                enabled: !root.directory.loading
                                hoverEnabled: true
                                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                                onClicked: Ghostd.loadMoreDocuments(root.selectedFolder, root.query)
                            }
                            Keys.onPressed: event => {
                                if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space)
                                        && !root.directory.loading) {
                                    Ghostd.loadMoreDocuments(root.selectedFolder, root.query);
                                    event.accepted = true;
                                }
                            }
                        }
                    }
                    Repeater {
                        model: root.directory.skipped
                        Rectangle {
                            required property var modelData
                            width: parent.width
                            height: skippedText.implicitHeight + Theme.gap * 2
                            radius: Theme.radius / 2
                            color: Theme.amber(0.06)
                            Text {
                                id: skippedText
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.gap
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.gap
                                anchors.verticalCenter: parent.verticalCenter
                                text: parent.modelData.name + " · " + parent.modelData.reason
                                color: Theme.warn
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }
                        }
                    }
                }

                Item {
                    anchors.fill: parent
                    visible: root.entries.length === 0
                    Column {
                        anchors.centerIn: parent
                        width: Math.min(parent.width - Theme.pad * 2, Theme.pad * 16)
                        spacing: Theme.gap
                        Text {
                            width: parent.width
                            text: {
                                if (root.directory.loading || queryDelay.running) return "Reading Documents…";
                                if (root.query !== "") return "No matches in this folder";
                                if (root.directory.nextCursor !== "" && root.query === "")
                                    return "Files may be on a later page";
                                if (root.directory.loaded && root.directory.directoryCount > 0)
                                    return "No files directly in this folder";
                                return root.selectedFolder === "" ? "Documents is empty" : "This folder is empty";
                            }
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            font.weight: Font.DemiBold
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                        }
                        Text {
                            objectName: "documentsEmptyBody"
                            width: parent.width
                            text: root.directory.nextCursor !== "" && root.query === ""
                                ? "Folders are listed first. Load more to check later pages for files."
                                : (root.directory.directoryCount > 0 && root.query === ""
                                    ? "Choose a subfolder from the folder list."
                                : (root.query !== "" ? "Try another file or folder name."
                                    : "Files and folders placed here will appear without being copied into a ghost."))
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }

            Rectangle {
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: root.wide ? 1 : 0
                color: Theme.border
            }
        }

        // ---- File detail --------------------------------------------------

        Item {
            id: detailPane
            anchors.left: root.wide ? listPane.right : parent.left
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            visible: root.wide || root.compactStage === "detail"

            Rectangle {
                id: compactDetailBack
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: parent.top
                visible: !root.wide
                height: visible ? Theme.controlHeight : 0
                color: Theme.surface
                activeFocusOnTab: visible
                Accessible.role: Accessible.Button
                Accessible.name: "Back to files in "
                    + (Documents.baseName(root.selectedFolder) || "Documents")
                Text {
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad
                    anchors.verticalCenter: parent.verticalCenter
                    text: "‹ " + (Documents.baseName(root.selectedFolder) || "Documents")
                    color: backToFiles.containsMouse ? Theme.ghostAmberBright : Theme.ghostAmber
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }
                MouseArea {
                    id: backToFiles
                    anchors.fill: parent
                    hoverEnabled: true
                    cursorShape: Qt.PointingHandCursor
                    onClicked: root.compactStage = "files"
                }
                Keys.onPressed: event => {
                    if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                            || event.key === Qt.Key_Space) {
                        root.compactStage = "files";
                        event.accepted = true;
                    }
                }
            }

            Item {
                anchors.left: parent.left
                anchors.right: parent.right
                anchors.top: compactDetailBack.bottom
                anchors.bottom: parent.bottom

                Loader {
                    id: editorLoader
                    objectName: "documentsInlineEditorLoader"
                    anchors.fill: parent
                    visible: root.selectedOpenable
                    active: root.selectedOpenable
                    sourceComponent: Component {
                        DocumentView {
                            objectName: "documentsInlineContentView"
                            filePath: root.selectedAbsolutePath
                            source: Ghostd.documentContent
                            modifiedAt: Ghostd.documentContentModifiedAt
                            byteSize: Ghostd.documentContentSize
                            onReloadRequested: Ghostd.fetchDocumentContent(root.selectedPath, true)
                            onExternalRequested: ExternalLinks.openPath(root.selectedAbsolutePath)
                            onClosed: {
                                Ghostd.clearDocumentContent();
                                root.setSelection("");
                                if (!root.wide) root.compactStage = "files";
                            }
                        }
                    }
                }

                Item {
                    anchors.fill: parent
                    visible: root.selectedEntry !== null && !root.selectedOpenable
                    Column {
                        anchors.centerIn: parent
                        width: Math.min(parent.width - Theme.pad * 2, Theme.pad * 22)
                        spacing: Theme.gap
                        Text {
                            width: parent.width
                            text: root.selectedEntry ? root.selectedEntry.name : ""
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize + 2
                            font.weight: Font.DemiBold
                            horizontalAlignment: Text.AlignHCenter
                            elide: Text.ElideMiddle
                        }
                        Text {
                            width: parent.width
                            text: root.selectedEntry
                                ? root.formatDate(root.selectedEntry.modifiedAt) + " · "
                                    + root.formatSize(root.selectedEntry.size) : ""
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                        }
                        Text {
                            objectName: "documentsInlineUnavailableReason"
                            width: parent.width
                            text: root.selectedInlineReason
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            horizontalAlignment: Text.AlignHCenter
                            wrapMode: Text.WordWrap
                        }
                        Rectangle {
                            id: externalButton
                            anchors.horizontalCenter: parent.horizontalCenter
                            width: externalLabel.implicitWidth + Theme.pad * 2
                            height: Theme.controlHeight
                            radius: Theme.radius / 2
                            color: externalMouse.containsMouse ? Theme.amber(0.15) : Theme.amber(0.10)
                            border.width: 1
                            border.color: activeFocus ? Theme.amber(0.65) : Theme.amber(0.25)
                            activeFocusOnTab: visible
                            Accessible.role: Accessible.Button
                            Accessible.name: "Open "
                                + (root.selectedEntry ? root.selectedEntry.name : "file")
                                + " externally"
                            Accessible.description: root.selectedInlineReason
                            Text {
                                id: externalLabel
                                anchors.centerIn: parent
                                text: "Open externally ↗"
                                color: Theme.ghostAmber
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }
                            MouseArea {
                                id: externalMouse
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: ExternalLinks.openPath(root.selectedAbsolutePath)
                            }
                            Keys.onPressed: event => {
                                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space) {
                                    ExternalLinks.openPath(root.selectedAbsolutePath);
                                    event.accepted = true;
                                }
                            }
                        }
                    }
                }

                Item {
                    anchors.fill: parent
                    visible: root.selectedEntry === null
                    Column {
                        anchors.centerIn: parent
                        width: Math.min(parent.width - Theme.pad * 2, Theme.pad * 20)
                        spacing: Theme.gap
                        Text {
                            width: parent.width
                            text: "Choose a document"
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize + 1
                            font.weight: Font.DemiBold
                            horizontalAlignment: Text.AlignHCenter
                        }
                        Text {
                            width: parent.width
                            text: "Select a file from "
                                + (Documents.baseName(root.selectedFolder) || "Documents") + "."
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
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
        open: root.pendingDeletePath !== ""
        title: "Delete document?"
        body: "“" + root.pendingDeleteName
            + "” moves to system Trash and can be restored from your file manager."
        confirmText: "Move to Trash"
        busy: Ghostd.documentDeletingPath === root.pendingDeletePath
            && root.pendingDeletePath !== ""
        error: root.pendingDeletePath !== "" ? Ghostd.documentDeleteError : ""
        onConfirmed: root.confirmDelete()
        onDismissed: root.dismissDelete()
    }
}
