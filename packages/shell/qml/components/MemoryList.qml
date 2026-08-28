pragma ComponentBehavior: Bound

// The active ghost's memory, shown as what it is on disk: one plain fact per
// Markdown file. The fact is the row. Click one to edit it in place; leaving
// the field saves through the daemon's validating writer, Escape discards.
// "New" is an empty row. There is no detail pane and no refresh button: the
// memory directory is watched, so the ghost's own writes and its idle
// consolidation appear as they land.
//
// While a row is being edited the list is frozen on the rows it had, so a
// write landing elsewhere cannot rebuild the delegates under the caret. The
// live list takes over again the moment the edit ends.
import QtQuick
import Qt.labs.folderlistmodel
import qs.services
import "MemoryEdit.js" as MemoryEdit

Rectangle {
    id: root

    /** The row being edited: its path ("memory/" for the draft), slug, and
        the fact as it was when the edit began. */
    property string editingPath: ""
    property string editingSlug: ""
    property string editingOriginal: ""
    property string editText: ""
    property var frozenRows: []
    /** What the last commit sent, so a refused write can hand the text back. */
    property var lastAttempt: null

    readonly property var memory: Ghostd.memory
    readonly property bool editing: root.editingPath !== ""
    readonly property var rows: root.editing ? root.frozenRows : root.memory
    readonly property bool busy: Ghostd.memoryBusyPath !== ""
    readonly property string memoryDir: Workbench.absolute("memory")
    readonly property string error: Ghostd.memoryActionError !== ""
        ? Ghostd.memoryActionError : Ghostd.memoryError

    implicitWidth: Theme.pad * 50
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function beginEdit(row: var): void {
        if (root.busy || root.editing || !row) return;
        Ghostd.memoryActionError = "";
        const draft = row.path === MemoryEdit.DRAFT.path;
        root.frozenRows = draft ? [row].concat(root.memory) : root.memory;
        root.editingSlug = MemoryEdit.text(row.slug);
        root.editingOriginal = MemoryEdit.text(row.content);
        root.editText = root.editingOriginal;
        root.editingPath = MemoryEdit.text(row.path);
    }

    function beginDraft(): void {
        root.beginEdit(MemoryEdit.DRAFT);
    }

    function endEdit(): void {
        root.editingPath = "";
        root.editingSlug = "";
        root.editingOriginal = "";
        root.editText = "";
        root.frozenRows = [];
    }

    /** Leaving the field is the save. */
    function commitEdit(): void {
        if (!root.editing) return;
        const attempt = {
            path: root.editingPath,
            slug: root.editingSlug,
            original: root.editingOriginal,
            text: root.editText
        };
        root.endEdit();
        if (!MemoryEdit.shouldWrite(attempt.original, attempt.text)) return;
        root.lastAttempt = attempt;
        Ghostd.writeMemory(attempt.slug, attempt.text.trim());
    }

    function remove(path: string): void {
        if (root.busy || root.editing || path === "") return;
        Ghostd.deleteMemory(path);
    }

    onVisibleChanged: if (!root.visible) root.commitEdit()

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            root.endEdit();
        }

        // A refused write hands the text back rather than losing it: the row
        // reopens with what was typed, under the daemon's reason.
        function onMemoryWriteFinished(path: string, ok: bool): void {
            const attempt = root.lastAttempt;
            if (ok || !attempt || attempt.path !== path) return;
            root.beginEdit({ path: attempt.path, slug: attempt.slug,
                             content: attempt.original, updated: "" });
            root.editText = attempt.text;
        }
    }

    // The directory is the source of truth; any entry change re-reads it.
    // Atomic writes land as a rename, which the directory watch does see. A
    // hidden pane never reads: showing it fetches (GhostHud.showSection).
    FolderListModel {
        id: watcher
        folder: root.memoryDir === "" ? "" : "file://" + root.memoryDir
        nameFilters: ["*.md"]
        showDirs: false
        showDotAndDotDot: false
        onCountChanged: refetch.restart()
        onStatusChanged: {
            if (watcher.status === FolderListModel.Ready && root.visible) Ghostd.fetchMemory(false);
        }
    }

    Connections {
        target: watcher
        function onDataChanged(): void { refetch.restart(); }
        function onModelReset(): void { refetch.restart(); }
    }

    Timer {
        id: refetch
        interval: 150
        onTriggered: if (root.visible) Ghostd.fetchMemory(true)
    }

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
                text: "Memory"
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
                visible: root.busy || Ghostd.memoryLoading
                text: root.busy ? "Saving…" : "Reading…"
                color: Theme.ghostAmber
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }
        }

        Rectangle {
            id: newButton
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            width: newLabel.implicitWidth + Theme.pad
            height: Theme.controlHeight
            radius: Theme.radius / 2
            color: newArea.containsMouse && newArea.enabled ? Theme.film(0.06) : "transparent"
            border.width: newButton.activeFocus ? 1 : 0
            border.color: Theme.amber(0.55)
            activeFocusOnTab: newArea.enabled

            Accessible.role: Accessible.Button
            Accessible.name: "New memory"

            Text {
                id: newLabel
                anchors.centerIn: parent
                text: "+ New"
                color: newArea.enabled
                    ? (newArea.containsMouse ? Theme.ghostAmber : Theme.foregroundDim)
                    : Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            MouseArea {
                id: newArea
                anchors.fill: parent
                enabled: Ghostd.activeGhost !== "" && !root.busy && !root.editing
                hoverEnabled: true
                cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                onClicked: root.beginDraft()
            }

            Keys.onPressed: event => {
                if (newArea.enabled && (event.key === Qt.Key_Return
                        || event.key === Qt.Key_Enter || event.key === Qt.Key_Space)) {
                    root.beginDraft();
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
        visible: root.error !== ""
        height: visible ? errorText.implicitHeight + Theme.gap * 2 : 0
        color: Theme.rose(0.08)

        Text {
            id: errorText
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad
            anchors.verticalCenter: parent.verticalCenter
            text: root.error
            color: Theme.danger
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }
    }

    Flickable {
        id: scroll
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: errorBanner.bottom
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: list.implicitHeight + Theme.pad * 2
        clip: true
        interactive: contentHeight > height
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: list
            x: Theme.pad
            y: Theme.pad
            width: scroll.width - Theme.pad * 2
            spacing: Theme.gap / 2

            Repeater {
                id: factRows
                model: root.rows

                Rectangle {
                    id: factRow
                    required property var modelData
                    readonly property string path: MemoryEdit.text(factRow.modelData.path)
                    readonly property string slug: MemoryEdit.text(factRow.modelData.slug)
                    readonly property string content: MemoryEdit.text(factRow.modelData.content)
                    readonly property string day:
                        MemoryEdit.dayLabel(factRow.modelData.updated, new Date())
                    readonly property bool editing: root.editingPath === factRow.path
                    readonly property bool draft: factRow.slug === ""
                    readonly property bool rowBusy: Ghostd.memoryBusyPath === factRow.path

                    width: list.width
                    height: factColumn.implicitHeight + Theme.gap * 2
                    radius: Theme.radius / 2
                    color: factRow.editing ? Theme.amber(0.08)
                        : (rowArea.containsMouse ? Theme.film(0.04) : "transparent")
                    opacity: factRow.rowBusy ? 0.5 : 1

                    Accessible.role: Accessible.ListItem
                    Accessible.name: factRow.draft ? "New memory" : factRow.content

                    Behavior on color {
                        enabled: !Theme.reducedMotion
                        ColorAnimation { duration: Theme.durFast }
                    }

                    MouseArea {
                        id: rowArea
                        anchors.fill: parent
                        enabled: !factRow.editing && !root.editing && !root.busy
                        hoverEnabled: true
                        cursorShape: enabled ? Qt.IBeamCursor : Qt.ArrowCursor
                        onClicked: root.beginEdit(factRow.modelData)
                    }

                    Column {
                        id: factColumn
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.gap
                        anchors.right: deleteButton.left
                        anchors.rightMargin: Theme.gap
                        anchors.top: parent.top
                        anchors.topMargin: Theme.gap
                        spacing: Theme.gap / 2

                    Item {
                        id: factBody
                        width: parent.width
                        implicitHeight: factRow.editing ? editorLoader.implicitHeight
                            : factText.implicitHeight

                        Text {
                            id: factText
                            width: parent.width
                            visible: !factRow.editing
                            text: factRow.content
                            textFormat: Text.PlainText
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            lineHeight: Theme.lineHeight
                            wrapMode: Text.Wrap
                        }

                        Loader {
                            id: editorLoader
                            width: parent.width
                            active: factRow.editing
                            visible: active

                            sourceComponent: Item {
                                implicitHeight: editor.height

                                TextEdit {
                                    id: editor
                                    width: editorLoader.width
                                    height: Math.max(contentHeight, font.pixelSize * 2)
                                    text: root.editText
                                    textFormat: TextEdit.PlainText
                                    wrapMode: TextEdit.Wrap
                                    selectByMouse: true
                                    color: Theme.foregroundBright
                                    selectionColor: Theme.selection
                                    selectedTextColor: Theme.foregroundBright
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSize
                                    Accessible.name: "Edit memory"

                                    onTextChanged: root.editText = editor.text
                                    onActiveFocusChanged: {
                                        // Losing the caret is the save; a row that
                                        // already ended its edit has nothing to save.
                                        if (!editor.activeFocus && factRow.editing) root.commitEdit();
                                    }
                                    Keys.onEscapePressed: event => {
                                        root.endEdit();
                                        event.accepted = true;
                                    }
                                    Keys.onPressed: event => {
                                        if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                                                && (event.modifiers & Qt.ControlModifier)) {
                                            root.commitEdit();
                                            event.accepted = true;
                                        }
                                    }
                                    Component.onCompleted: {
                                        editor.cursorPosition = editor.length;
                                        editor.forceActiveFocus();
                                    }

                                    Text {
                                        visible: editor.text === ""
                                        text: "One fact worth keeping"
                                        color: Theme.foregroundFaint
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSize
                                    }
                                }
                            }
                        }
                    }

                        Text {
                            width: parent.width
                            visible: !factRow.draft
                            text: factRow.slug + (factRow.day === "" ? "" : " · " + factRow.day)
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            elide: Text.ElideRight
                        }
                    }

                    Rectangle {
                        id: deleteButton
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.gap
                        anchors.top: parent.top
                        anchors.topMargin: Theme.gap / 2
                        visible: !factRow.draft
                        width: Theme.controlHeight - Theme.gap
                        height: width
                        radius: Theme.radius / 2
                        color: deleteArea.containsMouse && deleteArea.enabled
                            ? Theme.rose(0.12) : "transparent"

                        Accessible.role: Accessible.Button
                        Accessible.name: "Delete " + factRow.slug

                        Text {
                            anchors.centerIn: parent
                            text: "×"
                            color: deleteArea.containsMouse && deleteArea.enabled
                                ? Theme.danger : Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize + 2
                        }

                        MouseArea {
                            id: deleteArea
                            anchors.fill: parent
                            enabled: !root.busy && !root.editing
                            hoverEnabled: true
                            cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                            onClicked: root.remove(factRow.path)
                        }
                    }
                }
            }

            Item {
                width: list.width
                height: emptyCopy.implicitHeight + Theme.pad * 2
                visible: root.rows.length === 0

                Column {
                    id: emptyCopy
                    anchors.centerIn: parent
                    width: Math.min(parent.width, Theme.pad * 24)
                    spacing: Theme.gap / 2

                    Text {
                        width: parent.width
                        horizontalAlignment: Text.AlignHCenter
                        text: {
                            if (Ghostd.activeGhost === "") return "No ghost selected";
                            if (Ghostd.memoryLoading) return "Reading memory";
                            if (Ghostd.memoryError !== "") return "Memory unavailable";
                            return "Nothing remembered yet";
                        }
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        font.weight: Font.DemiBold
                        wrapMode: Text.WordWrap
                    }

                    Text {
                        width: parent.width
                        horizontalAlignment: Text.AlignHCenter
                        text: {
                            if (Ghostd.activeGhost === "") return "Choose a ghost to see what it remembers.";
                            if (Ghostd.memoryLoading || Ghostd.memoryError !== "") return "";
                            return "The ghost writes a fact here when it learns one worth keeping. "
                                + "You can add one too.";
                        }
                        visible: text !== ""
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        wrapMode: Text.WordWrap
                    }
                }
            }

            Text {
                width: list.width
                topPadding: Theme.gap
                visible: Ghostd.memorySkipped.length > 0
                text: Ghostd.memorySkipped.map(function (entry) {
                    return "Skipped " + MemoryEdit.text(entry.path) + ": " + MemoryEdit.text(entry.reason);
                }).join("\n")
                color: Theme.foregroundFaint
                font.family: Theme.fontFamilyMono
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
            }
        }
    }
}
