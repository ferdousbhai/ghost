pragma ComponentBehavior: Bound

// Conversation-scoped native coding workers. This is a supervisory surface:
// Ghost remains the principal owner-agent, while Pi, Codex, and Claude Code
// own coding mechanics in the exact trusted project selected for the session.
import QtQuick
import QtQuick.Layouts
import qs.services
import "../services/DelegationModel.js" as DelegationModel

Rectangle {
    id: root

    signal chatRequested()

    property string selectedHarness: "pi"
    readonly property bool hasConversation:
        Ghostd.activeGhost !== "" && Ghostd.currentSessionId !== ""
    readonly property bool hasTrustedProject: root.hasConversation
        && Ghostd.projectGhost === Ghostd.activeGhost
        && Ghostd.projectSessionId === Ghostd.currentSessionId
        && Ghostd.projectState.id === Ghostd.currentSessionId
        && Ghostd.projectState.root !== null
    readonly property bool selectedHarnessAvailable:
        Ghostd.nativeHarnesses.some(function (row) {
            return row.id === root.selectedHarness && row.availability === "available"
                && row.authentication !== "logged_out";
        })
    readonly property bool canCreate: root.hasTrustedProject
        && root.selectedHarnessAvailable && assignmentInput.text.trim() !== ""
        && assignmentInput.text.trim().length <= 32768
        && !Ghostd.delegatedTaskMutating
    readonly property bool hasActiveTasks: Ghostd.delegatedTasks.some(function (task) {
        return DelegationModel.active(task.state);
    })

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function load(force: bool): void {
        Ghostd.fetchNativeHarnesses(force);
        if (root.hasConversation) {
            Ghostd.fetchProject(false, false);
            Ghostd.fetchDelegatedTasks(force);
        }
    }

    function chooseAvailableHarness(): void {
        if (root.selectedHarnessAvailable) return;
        const available = Ghostd.nativeHarnesses.find(function (row) {
            return row.availability === "available"
                && row.authentication !== "logged_out";
        });
        if (available) root.selectedHarness = available.id;
    }

    function submit(): void {
        if (!root.canCreate) return;
        Ghostd.createDelegatedTask(root.selectedHarness, assignmentInput.text);
    }

    function statusColor(state: string): var {
        if (state === "completed") return Theme.ok;
        if (state === "failed" || state === "interrupted") return Theme.ghostRose;
        if (state === "cancelled") return Theme.foregroundFaint;
        return Theme.ghostAmber;
    }

    Component.onCompleted: root.load(false)
    onVisibleChanged: if (root.visible) root.load(false)

    Connections {
        target: Ghostd

        function refreshIdentity(): void {
            assignmentInput.text = "";
            if (root.visible) root.load(false);
        }

        function onActiveGhostChanged(): void { refreshIdentity(); }
        function onCurrentSessionIdChanged(): void { refreshIdentity(); }
        function onNativeHarnessesChanged(): void { root.chooseAvailableHarness(); }
        function onDelegatedTaskMutationFinished(action: string, ok: bool): void {
            if (!ok) return;
            if (action === "create") assignmentInput.text = "";
            else if (action === "send") followUpInput.text = "";
        }
    }

    Timer {
        interval: 2500
        repeat: true
        running: root.visible && root.hasActiveTasks
        onTriggered: {
            Ghostd.fetchDelegatedTasks(true);
            if (Ghostd.selectedDelegatedTask
                    && DelegationModel.active(Ghostd.selectedDelegatedTask.state))
                Ghostd.fetchDelegatedTask(Ghostd.selectedDelegatedTask.id, true);
        }
    }

    ColumnLayout {
        anchors.fill: parent
        anchors.margins: Theme.pad
        spacing: Theme.pad

        RowLayout {
            Layout.fillWidth: true
            spacing: Theme.gap

            ColumnLayout {
                Layout.fillWidth: true
                spacing: Theme.gap / 3

                Text {
                    objectName: "delegationTitle"
                    Layout.fillWidth: true
                    text: "Delegation"
                    textFormat: Text.PlainText
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeHeading
                    font.weight: Font.DemiBold
                }

                Text {
                    Layout.fillWidth: true
                    text: "Supervise native coding workers for this conversation's trusted project."
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            ActionButton {
                objectName: "delegationRefreshButton"
                label: Ghostd.nativeHarnessesLoading || Ghostd.delegatedTasksLoading
                    ? "Refreshing" : "Refresh"
                enabled: !Ghostd.nativeHarnessesLoading && !Ghostd.delegatedTasksLoading
                    && !Ghostd.delegatedTaskMutating
                onClicked: root.load(true)
            }
        }

        RowLayout {
            id: harnessRow
            objectName: "delegationHarnesses"
            Layout.fillWidth: true
            spacing: Theme.gap

            Repeater {
                model: Ghostd.nativeHarnesses

                Rectangle {
                    id: harnessCard
                    required property var modelData
                    Layout.fillWidth: true
                    Layout.minimumWidth: 110
                    implicitHeight: harnessColumn.implicitHeight + Theme.pad
                    radius: Theme.radius
                    color: root.selectedHarness === harnessCard.modelData.id
                        ? Theme.amber(0.10) : Theme.film(0.04)
                    border.width: 1
                    border.color: root.selectedHarness === harnessCard.modelData.id
                        ? Theme.amber(0.35) : Theme.border
                    opacity: harnessCard.modelData.availability === "available" ? 1 : 0.65
                    activeFocusOnTab: true

                    Accessible.role: Accessible.RadioButton
                    Accessible.name: DelegationModel.label(harnessCard.modelData.id)
                    Accessible.description: DelegationModel.availabilityLabel(harnessCard.modelData)
                    Accessible.checked: root.selectedHarness === harnessCard.modelData.id

                    Column {
                        id: harnessColumn
                        anchors.left: parent.left
                        anchors.leftMargin: Theme.gap
                        anchors.right: parent.right
                        anchors.rightMargin: Theme.gap
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: Theme.gap / 4

                        Text {
                            width: parent.width
                            text: DelegationModel.label(harnessCard.modelData.id)
                            textFormat: Text.PlainText
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            font.weight: Font.DemiBold
                            elide: Text.ElideRight
                        }

                        Text {
                            width: parent.width
                            text: DelegationModel.availabilityLabel(harnessCard.modelData)
                            textFormat: Text.PlainText
                            color: harnessCard.modelData.authentication === "authenticated"
                                ? Theme.ok : Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeCaption
                            elide: Text.ElideRight
                        }
                    }

                    MouseArea {
                        anchors.fill: parent
                        enabled: harnessCard.modelData.availability === "available"
                            && harnessCard.modelData.authentication !== "logged_out"
                        cursorShape: enabled ? Qt.PointingHandCursor : Qt.ArrowCursor
                        onClicked: root.selectedHarness = harnessCard.modelData.id
                    }

                    Keys.onPressed: event => {
                        if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                || event.key === Qt.Key_Space)
                                && harnessCard.modelData.availability === "available"
                                && harnessCard.modelData.authentication !== "logged_out") {
                            root.selectedHarness = harnessCard.modelData.id;
                            event.accepted = true;
                        }
                    }
                }
            }

            Text {
                Layout.fillWidth: true
                visible: Ghostd.nativeHarnesses.length === 0
                text: Ghostd.nativeHarnessesLoading
                    ? "Checking native workers…"
                    : "Native workers are unavailable."
                textFormat: Text.PlainText
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                horizontalAlignment: Text.AlignHCenter
            }
        }

        Rectangle {
            Layout.fillWidth: true
            visible: Ghostd.nativeHarnessesError !== "" || Ghostd.delegatedTasksError !== ""
            implicitHeight: visible ? delegationError.implicitHeight + Theme.pad : 0
            radius: Theme.radius
            color: Theme.rose(0.08)
            border.width: visible ? 1 : 0
            border.color: Theme.rose(0.18)

            Text {
                id: delegationError
                anchors.left: parent.left
                anchors.leftMargin: Theme.pad / 2
                anchors.right: parent.right
                anchors.rightMargin: Theme.pad / 2
                anchors.verticalCenter: parent.verticalCenter
                text: Ghostd.delegatedTasksError !== ""
                    ? Ghostd.delegatedTasksError : Ghostd.nativeHarnessesError
                textFormat: Text.PlainText
                color: Theme.danger
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
            }
        }

        Rectangle {
            id: createCard
            objectName: "delegationCreateCard"
            Layout.fillWidth: true
            implicitHeight: createColumn.implicitHeight + Theme.pad * 1.5
            radius: Theme.radius
            color: Theme.film(0.04)
            border.width: 1
            border.color: root.hasTrustedProject ? Theme.border : Theme.amber(0.25)

            ColumnLayout {
                id: createColumn
                anchors.left: parent.left
                anchors.leftMargin: Theme.pad
                anchors.right: parent.right
                anchors.rightMargin: Theme.pad
                anchors.verticalCenter: parent.verticalCenter
                spacing: Theme.gap

                RowLayout {
                    Layout.fillWidth: true
                    spacing: Theme.gap

                    ColumnLayout {
                        Layout.fillWidth: true
                        spacing: Theme.gap / 4

                        Text {
                            Layout.fillWidth: true
                            text: root.hasTrustedProject ? "New coding assignment" : "Choose a trusted project first"
                            textFormat: Text.PlainText
                            color: Theme.foregroundBright
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            font.weight: Font.DemiBold
                        }

                        Text {
                            Layout.fillWidth: true
                            text: !root.hasConversation
                                ? "Open a conversation before delegating work."
                                : (root.hasTrustedProject
                                    ? "Project · " + Ghostd.projectState.cwd
                                    : "Delegated coding never starts from untrusted Home context.")
                            textFormat: Text.PlainText
                            color: Theme.foregroundDim
                            font.family: root.hasTrustedProject
                                ? Theme.fontFamilyMono : Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                            elide: Text.ElideMiddle
                        }
                    }

                    ActionButton {
                        visible: !root.hasTrustedProject
                        label: "Open chat"
                        onClicked: root.chatRequested()
                    }

                    ActionButton {
                        objectName: "delegationCreateButton"
                        visible: root.hasTrustedProject
                        label: Ghostd.delegatedTaskMutating ? "Starting" : "Delegate"
                        primary: true
                        enabled: root.canCreate
                        onClicked: root.submit()
                    }
                }

                Rectangle {
                    Layout.fillWidth: true
                    Layout.preferredHeight: 68
                    visible: root.hasTrustedProject
                    radius: Theme.radius / 2
                    color: Theme.surfaceDeep
                    border.width: 1
                    border.color: assignmentInput.activeFocus ? Theme.amber(0.50) : Theme.border

                    TextEdit {
                        id: assignmentInput
                        objectName: "delegationAssignment"
                        anchors.fill: parent
                        anchors.margins: Theme.gap
                        enabled: root.hasTrustedProject && !Ghostd.delegatedTaskMutating
                        textFormat: TextEdit.PlainText
                        wrapMode: TextEdit.Wrap
                        color: Theme.foregroundBright
                        selectionColor: Theme.selection
                        selectedTextColor: Theme.foregroundBright
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSize
                        activeFocusOnTab: true
                        Accessible.name: "Coding assignment"

                        Text {
                            anchors.fill: parent
                            visible: assignmentInput.text === ""
                            text: "Describe the complete outcome for the coding worker…"
                            textFormat: Text.PlainText
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSize
                            wrapMode: Text.WordWrap
                        }

                        Keys.onPressed: event => {
                            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter)
                                    && (event.modifiers & Qt.ControlModifier)) {
                                root.submit();
                                event.accepted = true;
                            }
                        }
                    }
                }
            }
        }

        RowLayout {
            Layout.fillWidth: true
            Layout.fillHeight: true
            spacing: Theme.pad

            Rectangle {
                Layout.preferredWidth: 260
                Layout.minimumWidth: 190
                Layout.fillHeight: true
                radius: Theme.radius
                color: Theme.surface
                border.width: 1
                border.color: Theme.border
                clip: true

                Text {
                    id: taskEmpty
                    anchors.centerIn: parent
                    width: parent.width - Theme.pad * 2
                    visible: Ghostd.delegatedTasks.length === 0
                    text: Ghostd.delegatedTasksLoading
                        ? "Loading coding tasks…"
                        : (!root.hasConversation
                            ? "Open a conversation to see its coding tasks."
                            : "No coding tasks in this conversation yet.")
                    textFormat: Text.PlainText
                    color: Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignHCenter
                }

                ListView {
                    id: taskList
                    objectName: "delegationTaskList"
                    anchors.fill: parent
                    anchors.margins: Theme.gap
                    visible: Ghostd.delegatedTasks.length > 0
                    model: Ghostd.delegatedTasks
                    spacing: Theme.gap
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

                    delegate: Rectangle {
                        id: taskCard
                        required property var modelData
                        readonly property bool selected: Ghostd.selectedDelegatedTask
                            && Ghostd.selectedDelegatedTask.id === taskCard.modelData.id
                        width: ListView.view.width
                        height: taskCardColumn.implicitHeight + Theme.pad
                        radius: Theme.radius
                        color: taskCard.selected ? Theme.amber(0.10)
                            : (taskArea.containsMouse ? Theme.film(0.07) : Theme.film(0.04))
                        border.width: 1
                        border.color: taskCard.selected ? Theme.amber(0.35) : Theme.border
                        activeFocusOnTab: true

                        Accessible.role: Accessible.ListItem
                        Accessible.name: DelegationModel.label(taskCard.modelData.harness)
                            + " task, " + DelegationModel.stateLabel(taskCard.modelData.state)
                        Accessible.description: taskCard.modelData.taskPreview

                        Column {
                            id: taskCardColumn
                            anchors.left: parent.left
                            anchors.leftMargin: Theme.gap
                            anchors.right: parent.right
                            anchors.rightMargin: Theme.gap
                            anchors.verticalCenter: parent.verticalCenter
                            spacing: Theme.gap / 3

                            Row {
                                width: parent.width
                                spacing: Theme.gap

                                Text {
                                    width: parent.width - taskState.implicitWidth - Theme.gap
                                    text: DelegationModel.label(taskCard.modelData.harness)
                                    textFormat: Text.PlainText
                                    color: Theme.foregroundBright
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    font.weight: Font.DemiBold
                                    elide: Text.ElideRight
                                }

                                Text {
                                    id: taskState
                                    text: DelegationModel.stateLabel(taskCard.modelData.state)
                                    textFormat: Text.PlainText
                                    color: root.statusColor(taskCard.modelData.state)
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeCaption
                                    font.weight: Font.DemiBold
                                }
                            }

                            Text {
                                width: parent.width
                                text: taskCard.modelData.taskPreview
                                textFormat: Text.PlainText
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                                maximumLineCount: 2
                                elide: Text.ElideRight
                            }

                            Text {
                                width: parent.width
                                text: taskCard.modelData.cwd
                                textFormat: Text.PlainText
                                color: Theme.foregroundFaint
                                font.family: Theme.fontFamilyMono
                                font.pixelSize: Theme.fontSizeCaption
                                elide: Text.ElideMiddle
                            }
                        }

                        MouseArea {
                            id: taskArea
                            anchors.fill: parent
                            hoverEnabled: true
                            cursorShape: Qt.PointingHandCursor
                            onClicked: Ghostd.fetchDelegatedTask(taskCard.modelData.id, true)
                        }

                        Keys.onPressed: event => {
                            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                                    || event.key === Qt.Key_Space) {
                                Ghostd.fetchDelegatedTask(taskCard.modelData.id, true);
                                event.accepted = true;
                            }
                        }
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
                    anchors.centerIn: parent
                    width: parent.width - Theme.pad * 2
                    visible: Ghostd.selectedDelegatedTask === null
                    text: Ghostd.delegatedTaskLoading
                        ? "Loading task detail…"
                        : "Choose a task to inspect its bounded progress and result."
                    textFormat: Text.PlainText
                    color: Theme.foregroundFaint
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                    horizontalAlignment: Text.AlignHCenter
                }

                Flickable {
                    id: detailScroll
                    anchors.fill: parent
                    anchors.margins: Theme.pad
                    visible: Ghostd.selectedDelegatedTask !== null
                    contentWidth: width
                    contentHeight: detailColumn.implicitHeight
                    clip: true
                    boundsBehavior: Flickable.StopAtBounds

                    Column {
                        id: detailColumn
                        width: detailScroll.width
                        spacing: Theme.pad

                        Row {
                            width: parent.width
                            spacing: Theme.gap

                            Column {
                                width: parent.width - detailState.implicitWidth - Theme.gap
                                spacing: Theme.gap / 3

                                Text {
                                    width: parent.width
                                    text: Ghostd.selectedDelegatedTask
                                        ? DelegationModel.label(Ghostd.selectedDelegatedTask.harness) : ""
                                    textFormat: Text.PlainText
                                    color: Theme.foregroundBright
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSubtitle
                                    font.weight: Font.DemiBold
                                    elide: Text.ElideRight
                                }

                                Text {
                                    width: parent.width
                                    text: Ghostd.selectedDelegatedTask
                                        ? Ghostd.selectedDelegatedTask.cwd : ""
                                    textFormat: Text.PlainText
                                    color: Theme.foregroundFaint
                                    font.family: Theme.fontFamilyMono
                                    font.pixelSize: Theme.fontSizeCaption
                                    elide: Text.ElideMiddle
                                }
                            }

                            Text {
                                id: detailState
                                text: Ghostd.selectedDelegatedTask
                                    ? DelegationModel.stateLabel(Ghostd.selectedDelegatedTask.state) : ""
                                textFormat: Text.PlainText
                                color: Ghostd.selectedDelegatedTask
                                    ? root.statusColor(Ghostd.selectedDelegatedTask.state)
                                    : Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: Font.DemiBold
                            }
                        }

                        Column {
                            width: parent.width
                            spacing: Theme.gap / 3

                            Text {
                                text: "Assignment"
                                textFormat: Text.PlainText
                                color: Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeCaption
                                font.capitalization: Font.AllUppercase
                                font.letterSpacing: 1
                            }

                            Text {
                                width: parent.width
                                text: Ghostd.selectedDelegatedTask
                                    ? Ghostd.selectedDelegatedTask.taskPreview : ""
                                textFormat: Text.PlainText
                                color: Theme.foreground
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }
                        }

                        Column {
                            width: parent.width
                            visible: Ghostd.selectedDelegatedTask
                                && Ghostd.selectedDelegatedTask.events.length > 0
                            spacing: Theme.gap

                            Text {
                                text: "Progress"
                                    + (Ghostd.selectedDelegatedTask
                                        && Ghostd.selectedDelegatedTask.eventsTruncated
                                        ? " · recent" : "")
                                textFormat: Text.PlainText
                                color: Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeCaption
                                font.capitalization: Font.AllUppercase
                                font.letterSpacing: 1
                            }

                            Repeater {
                                model: Ghostd.selectedDelegatedTask
                                    ? Ghostd.selectedDelegatedTask.events : []

                                Row {
                                    id: eventRow
                                    required property var modelData
                                    width: parent.width
                                    spacing: Theme.gap

                                    Rectangle {
                                        anchors.top: parent.top
                                        anchors.topMargin: 5
                                        width: 6
                                        height: 6
                                        radius: 3
                                        color: Theme.ghostAmber
                                    }

                                    Text {
                                        width: parent.width - Theme.gap - 6
                                        text: eventRow.modelData.message
                                        textFormat: Text.PlainText
                                        color: Theme.foregroundDim
                                        font.family: Theme.fontFamily
                                        font.pixelSize: Theme.fontSizeSmall
                                        wrapMode: Text.WordWrap
                                    }
                                }
                            }
                        }

                        Column {
                            width: parent.width
                            spacing: Theme.gap / 3

                            Text {
                                text: "Summary"
                                textFormat: Text.PlainText
                                color: Theme.foregroundFaint
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeCaption
                                font.capitalization: Font.AllUppercase
                                font.letterSpacing: 1
                            }

                            TextEdit {
                                width: parent.width
                                readOnly: true
                                selectByMouse: true
                                text: DelegationModel.summary(Ghostd.selectedDelegatedTask)
                                    + (Ghostd.selectedDelegatedTask
                                        && Ghostd.selectedDelegatedTask.resultTruncated
                                        ? "\n\nResult preview is truncated." : "")
                                textFormat: TextEdit.PlainText
                                wrapMode: TextEdit.Wrap
                                color: Theme.foreground
                                selectionColor: Theme.selection
                                selectedTextColor: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                            }
                        }

                        Text {
                            width: parent.width
                            visible: Ghostd.delegatedTaskNotice !== ""
                            text: Ghostd.delegatedTaskNotice
                            textFormat: Text.PlainText
                            color: Theme.ok
                            font.family: Theme.fontFamily
                            font.pixelSize: Theme.fontSizeSmall
                        }

                        Rectangle {
                            width: parent.width
                            visible: Ghostd.selectedDelegatedTask
                                && Ghostd.selectedDelegatedTask.state === "running"
                            height: 52
                            radius: Theme.radius / 2
                            color: Theme.surfaceDeep
                            border.width: 1
                            border.color: followUpInput.activeFocus ? Theme.amber(0.50) : Theme.border

                            TextEdit {
                                id: followUpInput
                                objectName: "delegationFollowUp"
                                anchors.fill: parent
                                anchors.margins: Theme.gap
                                enabled: !Ghostd.delegatedTaskMutating
                                textFormat: TextEdit.PlainText
                                wrapMode: TextEdit.Wrap
                                color: Theme.foregroundBright
                                selectionColor: Theme.selection
                                selectedTextColor: Theme.foregroundBright
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                activeFocusOnTab: true
                                Accessible.name: "Worker follow-up"

                                Text {
                                    anchors.fill: parent
                                    visible: followUpInput.text === ""
                                    text: "Add guidance while this worker is running…"
                                    textFormat: Text.PlainText
                                    color: Theme.foregroundFaint
                                    font.family: Theme.fontFamily
                                    font.pixelSize: Theme.fontSizeSmall
                                    wrapMode: Text.WordWrap
                                }
                            }
                        }

                        Row {
                            width: parent.width
                            spacing: Theme.gap
                            visible: Ghostd.selectedDelegatedTask
                                && DelegationModel.active(Ghostd.selectedDelegatedTask.state)

                            ActionButton {
                                objectName: "delegationSendButton"
                                visible: Ghostd.selectedDelegatedTask
                                    && Ghostd.selectedDelegatedTask.state === "running"
                                label: Ghostd.delegatedTaskMutating ? "Sending" : "Send follow-up"
                                enabled: followUpInput.text.trim() !== ""
                                    && followUpInput.text.trim().length <= 32768
                                    && !Ghostd.delegatedTaskMutating
                                onClicked: {
                                    Ghostd.sendDelegatedTask(
                                        Ghostd.selectedDelegatedTask.id, followUpInput.text);
                                }
                            }

                            ActionButton {
                                objectName: "delegationCancelButton"
                                label: Ghostd.selectedDelegatedTask
                                    && Ghostd.selectedDelegatedTask.state === "cancelling"
                                    ? "Cancelling" : "Cancel worker"
                                danger: true
                                enabled: Ghostd.selectedDelegatedTask
                                    && Ghostd.selectedDelegatedTask.state !== "cancelling"
                                    && !Ghostd.delegatedTaskMutating
                                onClicked: Ghostd.cancelDelegatedTask(
                                    Ghostd.selectedDelegatedTask.id)
                            }
                        }
                    }
                }
            }
        }
    }
}
