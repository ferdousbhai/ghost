pragma ComponentBehavior: Bound

// Owner-facing status and reverse controls for coding harnesses. Delegation
// starts in chat; this pane observes durable tasks and can steer or stop the
// exact native controller ghostd already owns.
import Quickshell
import QtQuick
import QtQuick.Layouts
import qs.services

Rectangle {
    id: root
    objectName: "harnessesBrowser"

    readonly property var task: Ghostd.selectedCodingTask
    readonly property bool compact: width < 720
    property string messageDraft: ""
    property string messageTaskId: ""

    signal closeRequested()

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function harnessState(harness: var): string {
        if (harness.installation === "missing") return "Not installed";
        if (harness.installation === "unknown") return "Install status unknown";
        if (harness.authentication === "unauthenticated") return "Sign-in needed";
        if (harness.authentication === "unknown" && harness.id !== "pi")
            return "Sign-in status unknown";
        return "Ready";
    }

    function harnessColor(harness: var): var {
        if (harness.installation === "missing") return Theme.foregroundFaint;
        if (harness.installation === "unknown"
                || harness.authentication === "unauthenticated"
                || (harness.authentication === "unknown" && harness.id !== "pi")) return Theme.warn;
        return Theme.ok;
    }

    function usageLine(harness: var): string {
        const usage = harness.usage;
        if (!usage) {
            if (harness.reason) return String(harness.reason);
            return harness.id === "pi" ? "Native Pi configuration" : "No usage snapshot";
        }
        const limits = usage.limits;
        if (!limits || typeof limits.length !== "number" || limits.length === 0)
            return usage.status || "Usage available";
        const lines = [];
        for (let index = 0; index < limits.length; index += 1) {
            const limit = limits[index];
            const remaining = Math.max(0, Math.min(100,
                Math.round((1 - Number(limit.usedFraction || 0)) * 100)));
            lines.push(String(limit.label || "Limit") + " " + remaining + "% left");
        }
        return lines.join(" · ") + (usage.stale ? " · stale" : "");
    }

    function stateName(state: var): string {
        const value = String(state || "");
        if (value === "waiting_for_owner") return "Waiting for owner";
        if (value === "cancelling") return "Cancelling";
        if (value === "completed") return "Completed";
        if (value === "cancelled") return "Cancelled";
        if (value === "interrupted") return "Interrupted";
        if (value === "failed") return "Failed";
        if (value === "starting") return "Starting";
        if (value === "running") return "Running";
        return "Queued";
    }

    function stateColor(state: var): var {
        const value = String(state || "");
        if (value === "completed") return Theme.ok;
        if (value === "failed" || value === "interrupted") return Theme.ghostRose;
        if (value === "cancelled") return Theme.foregroundFaint;
        return Theme.ghostAmber;
    }

    function taskHarness(task: var): string {
        if (!task) return "Harness";
        const harness = String(task.harness || "Harness");
        return task.agent ? harness + " · requested " + String(task.agent) : harness;
    }

    function workspaceSummary(workspace: var): string {
        if (!workspace) return "No workspace state";
        if (workspace.strategy === "in-place") return "In place · no review branch";
        if (workspace.review === "ready") return "Local review branch ready";
        if (workspace.review === "no_changes") return "No changes";
        if (workspace.review === "needs_attention") return "Workspace needs attention";
        if (workspace.state === "preparing") return "Preparing worktree";
        return "Isolated worktree";
    }

    function eventLine(event: var): string {
        const detail = event.text === undefined ? "" : String(event.text);
        if (detail !== "") return detail;
        return event.type === "state" ? root.stateName(event.state) : String(event.type || "Event");
    }

    function copy(value: var): void {
        const text = value === null || value === undefined ? "" : String(value);
        if (text !== "") Quickshell.clipboardText = text;
    }

    function submitMessage(): void {
        if (!root.task || root.messageDraft.trim() === "") return;
        Ghostd.sendCodingTaskMessage(root.task.id, root.messageDraft);
    }

    function refreshAfterGhostChange(): void {
        if (root.visible && Ghostd.activeGhost !== "") Ghostd.fetchCoding(true);
    }

    Keys.onEscapePressed: event => {
        root.closeRequested();
        event.accepted = true;
    }

    Component.onCompleted: if (root.visible) Ghostd.fetchCoding(false)
    onVisibleChanged: if (root.visible) Ghostd.fetchCoding(true)

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            root.messageDraft = "";
            root.messageTaskId = "";
            Qt.callLater(root.refreshAfterGhostChange);
        }

        function onSelectedCodingTaskChanged(): void {
            const taskId = root.task ? String(root.task.id) : "";
            if (taskId === root.messageTaskId) return;
            root.messageTaskId = taskId;
            root.messageDraft = "";
        }

        function onCodingTaskMutationFinished(action: string, taskId: string, ok: bool): void {
            if (action === "send" && taskId === root.messageTaskId && ok)
                root.messageDraft = "";
        }
    }

    Timer {
        id: taskPoll
        objectName: "codingTaskPoll"
        interval: 3000
        repeat: true
        running: root.visible && Ghostd.codingHasUnsettledTasks
        onTriggered: Ghostd.fetchCodingTasks(true)
    }

    Timer {
        id: harnessPoll
        objectName: "codingHarnessPoll"
        interval: 30000
        repeat: true
        running: root.visible
        onTriggered: Ghostd.fetchCodingHarnesses(true)
    }

    ColumnLayout {
        anchors.fill: parent
        spacing: Theme.sectionGap

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            ColumnLayout {
                Layout.fillWidth: true
                spacing: 2

                Text {
                    objectName: "harnessesTitle"
                    Layout.fillWidth: true
                    text: "Coding harnesses"
                    textFormat: Text.PlainText
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSize + 3
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.fillWidth: true
                    text: "Ghost chooses and supervises them. This pane shows native capacity and durable work."
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            ActionButton {
                objectName: "harnessesRefresh"
                label: Ghostd.codingHarnessesLoading || Ghostd.codingTasksLoading
                    ? "Refreshing…" : "Refresh"
                enabled: !Ghostd.codingHarnessesLoading && !Ghostd.codingTasksLoading
                onClicked: Ghostd.fetchCoding(true)
            }
        }

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            Repeater {
                model: Ghostd.codingHarnesses

                Rectangle {
                    id: harnessCard
                    required property var modelData
                    objectName: "codingHarness-" + String(modelData.id || "")
                    Layout.fillWidth: true
                    Layout.preferredHeight: harnessContent.implicitHeight + Theme.pad
                    radius: Theme.radius
                    color: Theme.surface
                    border.width: 1
                    border.color: Theme.border

                    Column {
                        id: harnessContent
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.gap
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: 2

                        Text {
                            width: parent.width
                            text: String(harnessCard.modelData.name || harnessCard.modelData.id || "Harness")
                            textFormat: Text.PlainText
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            font.weight: Font.DemiBold
                            elide: Text.ElideRight
                        }

                        Text {
                            objectName: "codingHarnessState-" + String(harnessCard.modelData.id || "")
                            width: parent.width
                            text: root.harnessState(harnessCard.modelData)
                            textFormat: Text.PlainText
                            color: root.harnessColor(harnessCard.modelData)
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }

                        Text {
                            objectName: "codingHarnessUsage-" + String(harnessCard.modelData.id || "")
                            width: parent.width
                            text: root.usageLine(harnessCard.modelData)
                            textFormat: Text.PlainText
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall - 1
                            elide: Text.ElideRight
                        }
                    }
                }
            }
        }

        Text {
            visible: Ghostd.codingHarnessesError !== ""
                || (Ghostd.codingHarnessesLoaded && Ghostd.codingHarnesses.length === 0)
            Layout.fillWidth: true
            text: Ghostd.codingHarnessesError !== "" ? Ghostd.codingHarnessesError
                : "No coding harnesses were discovered."
            textFormat: Text.PlainText
            color: Ghostd.codingHarnessesError !== "" ? Theme.warn : Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }

        GridLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            columns: root.compact ? 1 : 2
            columnSpacing: Theme.sectionGap
            rowSpacing: Theme.gap

            Rectangle {
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.preferredWidth: root.compact ? -1 : 300
                Layout.preferredHeight: root.compact ? 170 : -1
                radius: Theme.radius
                color: Theme.surfaceDeep
                border.width: 1
                border.color: Theme.border
                clip: true

                ColumnLayout {
                    anchors.fill: parent
                    anchors.margins: Theme.gap
                    spacing: Theme.gap / 2

                    Text {
                        Layout.fillWidth: true
                        text: "Tasks"
                        textFormat: Text.PlainText
                        color: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        font.weight: Font.DemiBold
                    }

                    ListView {
                        id: taskList
                        objectName: "codingTaskList"
                        Layout.fillWidth: true
                        Layout.fillHeight: true
                        clip: true
                        spacing: Theme.gap / 2
                        model: Ghostd.codingTasks

                        delegate: Rectangle {
                            id: taskRow
                            required property var modelData
                            objectName: "codingTask-" + String(modelData.id || "")
                            readonly property bool selected:
                                Ghostd.selectedCodingTaskId === taskRow.modelData.id
                            width: taskList.width
                            height: taskRowContent.implicitHeight + Theme.gap
                            radius: Theme.radius
                            color: selected ? Theme.amber(0.13)
                                : (taskArea.containsMouse ? Theme.film(0.09) : Theme.film(0.04))
                            border.width: activeFocus || selected ? 1 : 0
                            border.color: selected ? Theme.amber(0.30) : Theme.borderStrong
                            activeFocusOnTab: true

                            Accessible.role: Accessible.Button
                            Accessible.name: String(taskRow.modelData.taskPreview || "Coding task")
                            Accessible.description: "Open task details"

                            Column {
                                id: taskRowContent
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.gap
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.gap
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: 2

                                Text {
                                    width: parent.width
                                    text: String(taskRow.modelData.taskPreview || "Coding task")
                                    textFormat: Text.PlainText
                                    color: Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold
                                    elide: Text.ElideRight
                                }

                                Text {
                                    width: parent.width
                                    text: root.taskHarness(taskRow.modelData) + " · "
                                        + root.stateName(taskRow.modelData.state) + " · "
                                        + root.workspaceSummary(taskRow.modelData.workspace)
                                    textFormat: Text.PlainText
                                    color: root.stateColor(taskRow.modelData.state)
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall - 1
                                    elide: Text.ElideRight
                                }
                            }

                            MouseArea {
                                id: taskArea
                                anchors.fill: parent
                                hoverEnabled: true
                                cursorShape: Qt.PointingHandCursor
                                onClicked: Ghostd.selectCodingTask(taskRow.modelData.id)
                            }

                            Keys.onPressed: event => {
                                if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                        || event.key === Qt.Key_Space) {
                                    Ghostd.selectCodingTask(taskRow.modelData.id);
                                    event.accepted = true;
                                }
                            }
                        }
                    }

                    Text {
                        visible: Ghostd.codingTasksError !== ""
                            || (Ghostd.codingTasksLoaded && Ghostd.codingTasks.length === 0)
                        Layout.fillWidth: true
                        text: Ghostd.codingTasksError !== "" ? Ghostd.codingTasksError
                            : "No delegated coding tasks yet."
                        textFormat: Text.PlainText
                        color: Ghostd.codingTasksError !== "" ? Theme.warn : Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
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
                clip: true

                Text {
                    objectName: "codingTaskPlaceholder"
                    anchors.centerIn: parent
                    visible: root.task === null && !Ghostd.codingTaskLoading
                    width: parent.width - Theme.pad * 2
                    text: Ghostd.codingTaskError !== "" ? Ghostd.codingTaskError
                        : "Choose a task to inspect its assignment, native progress, and local review artifact."
                    textFormat: Text.PlainText
                    color: Ghostd.codingTaskError !== "" ? Theme.warn : Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    horizontalAlignment: Text.AlignHCenter
                    wrapMode: Text.WordWrap
                }

                Text {
                    anchors.centerIn: parent
                    visible: Ghostd.codingTaskLoading && root.task === null
                    text: "Loading task…"
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                }

                Flickable {
                    id: detailScroll
                    anchors.fill: parent
                    anchors.margins: Theme.gap
                    visible: root.task !== null
                    contentWidth: width
                    contentHeight: detail.implicitHeight
                    clip: true
                    interactive: contentHeight > height
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: detail
                        width: detailScroll.width
                        spacing: Theme.gap

                        RowLayout {
                            width: parent.width
                            spacing: Theme.gap

                            Text {
                                objectName: "codingTaskState"
                                Layout.fillWidth: true
                                text: root.task ? root.taskHarness(root.task) + " · "
                                    + root.stateName(root.task.state) : ""
                                textFormat: Text.PlainText
                                color: root.task ? root.stateColor(root.task.state) : Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSize
                                font.weight: Font.DemiBold
                            }

                            ActionButton {
                                objectName: "codingTaskCancel"
                                visible: root.task !== null
                                    && !Ghostd.terminalCodingTaskState(root.task.state)
                                label: root.task && root.task.state === "cancelling"
                                    ? "Cancelling…" : "Cancel"
                                danger: true
                                enabled: root.task && root.task.state !== "cancelling"
                                    && !Ghostd.codingTaskMutating
                                onClicked: Ghostd.cancelCodingTask(root.task.id)
                            }
                        }

                        Text {
                            objectName: "codingTaskAssignment"
                            width: parent.width
                            text: root.task ? String(root.task.task || "") : ""
                            textFormat: Text.PlainText
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            wrapMode: Text.WordWrap
                        }

                        Rectangle {
                            width: parent.width
                            height: workspaceContent.implicitHeight + Theme.pad
                            radius: Theme.radius
                            color: Theme.film(0.05)
                            border.width: 1
                            border.color: root.task && root.task.workspace.review === "needs_attention"
                                ? Theme.rose(0.30) : Theme.border

                            Column {
                                id: workspaceContent
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.gap
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.gap
                                anchors.verticalCenter: parent.verticalCenter
                                spacing: 3

                                Text {
                                    objectName: "codingTaskWorkspaceSummary"
                                    width: parent.width
                                    text: root.task ? root.workspaceSummary(root.task.workspace) : ""
                                    textFormat: Text.PlainText
                                    color: root.task && root.task.workspace.review === "needs_attention"
                                        ? Theme.warn : Theme.foreground
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold
                                }

                                Text {
                                    width: parent.width
                                    text: root.task && root.task.workspace.notice
                                        ? String(root.task.workspace.notice) : ""
                                    textFormat: Text.PlainText
                                    color: Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    wrapMode: Text.WordWrap
                                }

                                TextEdit {
                                    objectName: "codingTaskBranch"
                                    visible: root.task && root.task.workspace.branch !== null
                                    width: parent.width
                                    text: visible ? String(root.task.workspace.branch) : ""
                                    readOnly: true
                                    selectByMouse: true
                                    textFormat: TextEdit.PlainText
                                    color: Theme.foregroundBright
                                    selectionColor: Theme.selection
                                    selectedTextColor: Theme.foregroundBright
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSizeSmall
                                    wrapMode: TextEdit.WrapAnywhere
                                    Accessible.name: "Local task branch"
                                }

                                TextEdit {
                                    objectName: "codingTaskWorkspacePath"
                                    width: parent.width
                                    text: root.task ? String(root.task.workspace.root || "") : ""
                                    readOnly: true
                                    selectByMouse: true
                                    textFormat: TextEdit.PlainText
                                    color: Theme.foregroundDim
                                    selectionColor: Theme.selection
                                    selectedTextColor: Theme.foregroundBright
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSizeSmall - 1
                                    wrapMode: TextEdit.WrapAnywhere
                                    Accessible.name: "Task workspace path"
                                }

                                Row {
                                    spacing: Theme.gap / 2

                                    ActionButton {
                                        visible: root.task && root.task.workspace.branch !== null
                                        label: "Copy branch"
                                        onClicked: root.copy(root.task.workspace.branch)
                                    }

                                    ActionButton {
                                        label: "Copy path"
                                        onClicked: root.copy(root.task.workspace.root)
                                    }
                                }
                            }
                        }

                        Text {
                            visible: root.task && root.task.error !== null
                            width: parent.width
                            text: visible ? String(root.task.error.message || "Task failed") : ""
                            textFormat: Text.PlainText
                            color: Theme.ghostRose
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }

                        Text {
                            objectName: "codingTaskResult"
                            visible: root.task && root.task.result !== null
                            width: parent.width
                            text: visible ? String(root.task.result) : ""
                            textFormat: Text.PlainText
                            color: Theme.foreground
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }

                        Column {
                            visible: root.task && Array.isArray(root.task.events)
                                && root.task.events.length > 0
                            width: parent.width
                            spacing: 3

                            Text {
                                width: parent.width
                                text: "Recent activity"
                                textFormat: Text.PlainText
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.DemiBold
                            }

                            Repeater {
                                model: root.task && Array.isArray(root.task.events)
                                    ? root.task.events.slice(-12) : []

                                Text {
                                    required property var modelData
                                    width: detail.width
                                    text: root.eventLine(modelData)
                                    textFormat: Text.PlainText
                                    color: modelData.type === "output"
                                        ? Theme.foreground : Theme.foregroundDim
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall - 1
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }

                        Rectangle {
                            visible: root.task && ["running", "waiting_for_owner"]
                                .indexOf(root.task.state) >= 0
                            width: parent.width
                            height: Math.max(Theme.controlHeight,
                                messageField.implicitHeight + Theme.gap)
                            radius: Theme.radius
                            color: Theme.surfaceDeep
                            border.width: messageField.activeFocus ? 1 : 0
                            border.color: Theme.amber(0.45)

                            TextEdit {
                                id: messageField
                                objectName: "codingTaskMessage"
                                anchors.left: parent.left
                                anchors.leftMargin: Theme.gap
                                anchors.right: sendButton.left
                                anchors.rightMargin: Theme.gap
                                anchors.verticalCenter: parent.verticalCenter
                                text: root.messageDraft
                                onTextChanged: if (root.messageDraft !== text)
                                    root.messageDraft = text
                                textFormat: TextEdit.PlainText
                                color: Theme.foreground
                                selectionColor: Theme.selection
                                selectedTextColor: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: TextEdit.Wrap
                                activeFocusOnTab: true

                                Keys.onPressed: event => {
                                    if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                                            && !(event.modifiers & Qt.ShiftModifier)) {
                                        root.submitMessage();
                                        event.accepted = true;
                                    }
                                }
                            }

                            ActionButton {
                                id: sendButton
                                objectName: "codingTaskSend"
                                anchors.right: parent.right
                                anchors.rightMargin: Theme.gap / 2
                                anchors.verticalCenter: parent.verticalCenter
                                label: Ghostd.codingTaskMutating ? "Sending…" : "Send"
                                primary: true
                                enabled: root.messageDraft.trim() !== ""
                                    && !Ghostd.codingTaskMutating
                                onClicked: root.submitMessage()
                            }
                        }

                        Text {
                            visible: Ghostd.codingTaskError !== ""
                            width: parent.width
                            text: Ghostd.codingTaskError
                            textFormat: Text.PlainText
                            color: Theme.warn
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            wrapMode: Text.WordWrap
                        }
                    }
                }
            }
        }
    }
}
