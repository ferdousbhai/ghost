pragma ComponentBehavior: Bound

// Conversation-scoped work that lives beyond one model turn: the plan,
// progress phases (the `todo` wire), and background jobs. Mutations stay in
// Ghostd; this component owns only disclosure state and the visible-HUD polling
// cadence.
import QtQuick
import QtQuick.Layouts
import qs.services

Rectangle {
    id: root
    objectName: "workStrip"

    component DisclosureRow: Rectangle {
        id: disclosure

        property string summary: ""
        property string summaryObjectName: ""
        property bool expanded: false
        property color accent: Theme.foreground
        property string description: ""
        property bool customContent: false
        signal toggled()

        implicitHeight: Theme.compactControlHeight
        radius: Theme.radius
        color: disclosureArea.containsMouse || activeFocus
            ? Theme.film(0.09) : Theme.film(0.04)
        activeFocusOnTab: true

        Accessible.role: Accessible.Button
        Accessible.name: disclosure.summary
        Accessible.description: disclosure.description

        Text {
            objectName: disclosure.summaryObjectName
            visible: !disclosure.customContent
            anchors.left: parent.left
            anchors.leftMargin: Theme.gap
            anchors.right: disclosureChevron.left
            anchors.rightMargin: Theme.gap
            anchors.verticalCenter: parent.verticalCenter
            text: disclosure.summary
            color: disclosure.accent
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            elide: Text.ElideRight
        }

        Text {
            id: disclosureChevron
            visible: !disclosure.customContent
            anchors.right: parent.right
            anchors.rightMargin: Theme.gap
            anchors.verticalCenter: parent.verticalCenter
            text: disclosure.expanded ? "⌃" : "⌄"
            color: Theme.foregroundDim
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        MouseArea {
            id: disclosureArea
            anchors.fill: parent
            z: 0
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: disclosure.toggled()
        }

        Keys.onPressed: event => {
            if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter
                    || event.key === Qt.Key_Space) {
                disclosure.toggled();
                event.accepted = true;
            }
        }
    }

    property bool todoExpanded: false
    property bool jobsExpanded: false
    property var expandedOutputs: ({})

    readonly property var todo: root.todoDigest()
    readonly property int runningJobCount: root.countJobs("running")
    readonly property int settledJobCount: Ghostd.workJobs.length - root.runningJobCount
    readonly property string progressSummary: "Progress · " + root.todo.done
        + "/" + root.todo.total + " done"
        + (root.todo.now === "" ? "" : " · Now: " + root.todo.now)
    readonly property string jobsSummary: "Jobs · " + root.runningJobCount
        + " running · " + root.settledJobCount + " done"

    visible: Ghostd.workHasContent
    implicitHeight: visible ? content.implicitHeight + Theme.gap * 2 : 0
    radius: Theme.radius
    color: Theme.surfaceDeep
    border.width: 1
    border.color: Theme.border
    clip: true

    function todoDigest(): var {
        const digest = { total: 0, done: 0, now: "" };
        for (const phase of (Ghostd.workTodo || [])) {
            for (const task of (phase && Array.isArray(phase.tasks) ? phase.tasks : [])) {
                digest.total += 1;
                if (task.status === "completed") digest.done += 1;
                if (digest.now === "" && task.status === "in_progress")
                    digest.now = String(task.content || "");
            }
        }
        return digest;
    }

    function countJobs(status: string): int {
        if (status === "running") return Ghostd.workRunningJobCount;
        return (Ghostd.workJobs || []).filter(function (job) {
            return job && job.status === status;
        }).length;
    }

    function taskGlyph(status: string): string {
        if (status === "completed") return "✓";
        if (status === "in_progress") return "▸";
        if (status === "blocked") return "⊘";
        if (status === "abandoned") return "−";
        return "·";
    }

    function taskStatusName(status: string): string {
        if (status === "completed") return "Done";
        if (status === "in_progress") return "In progress";
        if (status === "blocked") return "Blocked";
        if (status === "abandoned") return "Abandoned";
        return "Pending";
    }

    function taskColor(status: string): var {
        if (status === "in_progress") return Theme.ghostAmber;
        if (status === "completed") return Theme.ok;
        return status === "pending" ? Theme.foregroundDim : Theme.foregroundFaint;
    }

    function jobStatusName(job: var): string {
        if (job.status === "completed") return "done";
        return String(job.status || "");
    }

    function jobStatusColor(status: string): var {
        if (status === "running") return Theme.ghostAmber;
        if (status === "completed") return Theme.ok;
        if (status === "failed") return Theme.ghostRose;
        return Theme.foregroundFaint;
    }

    function duration(durationMs: var): string {
        const milliseconds = Math.max(0, Number(durationMs) || 0);
        const seconds = milliseconds / 1000;
        if (seconds < 10) {
            const tenths = Math.round(seconds * 10) / 10;
            return tenths.toFixed(tenths % 1 === 0 ? 0 : 1) + "s";
        }
        if (seconds < 60) return Math.round(seconds) + "s";
        const whole = Math.round(seconds);
        return Math.floor(whole / 60) + "m " + (whole % 60) + "s";
    }

    function outputExpanded(jobId: string): bool {
        return root.expandedOutputs[jobId] === true;
    }

    function toggleOutput(jobId: string): void {
        const next = Object.assign({}, root.expandedOutputs);
        next[jobId] = next[jobId] !== true;
        root.expandedOutputs = next;
    }

    function resetDisclosure(): void {
        root.todoExpanded = false;
        root.jobsExpanded = false;
        root.expandedOutputs = ({});
    }

    Component.onCompleted: Qt.callLater(function () {
        if (Ghostd.hudVisible && Ghostd.activeGhost !== "") Ghostd.fetchWork(false);
    })

    Connections {
        target: Ghostd

        function refreshSelection(): void {
            root.resetDisclosure();
            Qt.callLater(function () {
                if (Ghostd.hudVisible && Ghostd.activeGhost !== "") Ghostd.fetchWork(false);
            });
        }

        function onActiveGhostChanged(): void { refreshSelection(); }
        function onCurrentSessionIdChanged(): void { refreshSelection(); }

        function onHudVisibleChanged(): void {
            if (Ghostd.hudVisible && Ghostd.activeGhost !== "") Ghostd.fetchWork(true);
        }

        function onTurnFinished(ghost: string, text: string): void {
            if (ghost === Ghostd.activeGhost && Ghostd.hudVisible)
                Qt.callLater(function () { Ghostd.fetchWork(true); });
        }

        function onTurnFailed(ghost: string, message: string): void {
            if (ghost === Ghostd.activeGhost && Ghostd.hudVisible)
                Qt.callLater(function () { Ghostd.fetchWork(true); });
        }
    }

    Timer {
        id: workPollTimer
        objectName: "workPollTimer"
        interval: 3000
        repeat: true
        running: Ghostd.hudVisible && root.visible && Ghostd.workHasRunningJobs
        onTriggered: Ghostd.fetchWorkJobs(true, Ghostd.workGhost, Ghostd.workSessionId)
    }

    ColumnLayout {
        id: content
        anchors.left: parent.left
        anchors.leftMargin: Theme.gap
        anchors.right: parent.right
        anchors.rightMargin: Theme.gap
        anchors.top: parent.top
        anchors.topMargin: Theme.gap
        spacing: Theme.gap / 2

        RowLayout {
            id: planRow
            visible: Ghostd.workPlanning || Ghostd.workPlan !== null || !Ghostd.streaming
            Layout.fillWidth: true
            spacing: Theme.gap / 2

            Rectangle {
                id: planChip
                objectName: "workPlanChip"
                visible: Ghostd.workPlanning || Ghostd.workPlan !== null
                Layout.fillWidth: true
                implicitHeight: Theme.compactControlHeight
                radius: Theme.radius
                color: Ghostd.workPlanning ? Theme.amber(0.13) : Theme.film(0.05)
                border.width: 1
                border.color: Ghostd.workPlanning ? Theme.amber(0.28) : Theme.border

                Text {
                    id: planChipText
                    objectName: "workPlanChipText"
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.gap
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.gap
                    anchors.verticalCenter: parent.verticalCenter
                    text: Ghostd.workPlanning ? "Planning"
                        : (Ghostd.workPlan ? String(Ghostd.workPlan.title || "Plan") : "")
                    color: Ghostd.workPlanning ? Theme.ghostAmberBright : Theme.foreground
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    font.weight: Ghostd.workPlanning ? Font.DemiBold : Font.Normal
                    elide: Text.ElideRight
                }
            }

            Item {
                visible: !planChip.visible
                Layout.fillWidth: true
                implicitHeight: 1
            }

            ActionButton {
                objectName: "workPlanStopButton"
                visible: Ghostd.workPlanning
                label: "Stop planning"
                enabled: !Ghostd.streaming && !Ghostd.workMutating
                Accessible.description: "Leave plan mode and keep any approved plan."
                onClicked: Ghostd.planAction("stop")
            }

            ActionButton {
                objectName: "workPlanOpenButton"
                visible: !Ghostd.workPlanning && Ghostd.workPlan !== null
                label: "Open"
                enabled: !Ghostd.streaming && !Ghostd.workMutating
                Accessible.description: "Open the approved plan beside this conversation."
                onClicked: if (Ghostd.workPlan) Workbench.open(Ghostd.workPlan.path)
            }

            ActionButton {
                objectName: "workPlanClearButton"
                visible: !Ghostd.workPlanning && Ghostd.workPlan !== null
                label: "Clear"
                danger: true
                enabled: !Ghostd.streaming && !Ghostd.workMutating
                Accessible.description: "Remove the approved plan from this conversation."
                onClicked: Ghostd.planAction("clear")
            }

            ActionButton {
                objectName: "workPlanStartButton"
                visible: !Ghostd.workPlanning && Ghostd.workPlan === null
                    && !Ghostd.streaming
                label: "Plan first"
                primary: true
                enabled: !Ghostd.workMutating
                Accessible.description: "Ask the ghost to plan without changing files."
                onClicked: Ghostd.planAction("start")
            }
        }

        DisclosureRow {
            id: todoToggle
            objectName: "workTodoToggle"
            visible: Ghostd.workTodo.length > 0
            Layout.fillWidth: true
            summary: root.progressSummary
            summaryObjectName: "workTodoSummary"
            expanded: root.todoExpanded
            accent: Theme.foreground
            description: root.todoExpanded
                ? "Collapse conversation progress." : "Expand conversation progress."
            onToggled: root.todoExpanded = !root.todoExpanded
        }

        ColumnLayout {
            id: todoList
            objectName: "workTodoList"
            visible: todoToggle.visible && root.todoExpanded
            Layout.fillWidth: true
            Layout.leftMargin: Theme.gap
            Layout.rightMargin: Theme.gap
            spacing: Theme.gap / 2

            Repeater {
                model: Ghostd.workTodo

                delegate: ColumnLayout {
                    id: phaseDelegate
                    required property var modelData
                    required property int index
                    readonly property int phaseIndex: index
                    Layout.fillWidth: true
                    spacing: 2

                    Text {
                        Layout.fillWidth: true
                        text: String(phaseDelegate.modelData.name || "Tasks")
                        color: Theme.foregroundDim
                        font.family: Theme.fontFamily
                        font.pixelSize: Theme.fontSizeSmall
                        font.weight: Font.DemiBold
                        elide: Text.ElideRight
                    }

                    Repeater {
                        model: phaseDelegate.modelData.tasks || []

                        delegate: RowLayout {
                            id: taskDelegate
                            required property var modelData
                            required property int index
                            objectName: "workTodoTask-" + phaseDelegate.phaseIndex + "-" + index
                            readonly property string status: String(modelData.status || "pending")
                            readonly property string glyph: root.taskGlyph(status)
                            Layout.fillWidth: true
                            spacing: Theme.gap / 2

                            Text {
                                Layout.alignment: Qt.AlignTop
                                text: taskDelegate.glyph
                                color: root.taskColor(taskDelegate.status)
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: taskDelegate.status === "in_progress"
                                    ? Font.DemiBold : Font.Normal
                            }

                            Text {
                                Layout.fillWidth: true
                                text: String(taskDelegate.modelData.content || "")
                                    + (taskDelegate.status === "blocked"
                                        && String(taskDelegate.modelData.blocker || "") !== ""
                                        ? " — " + taskDelegate.modelData.blocker : "")
                                color: root.taskColor(taskDelegate.status)
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                wrapMode: Text.WordWrap
                            }

                            Text {
                                Layout.alignment: Qt.AlignTop
                                text: root.taskStatusName(taskDelegate.status)
                                color: root.taskColor(taskDelegate.status)
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall - 1
                            }
                        }
                    }
                }
            }
        }

        DisclosureRow {
            id: jobsToggle
            objectName: "workJobsToggle"
            visible: Ghostd.workJobs.length > 0
            Layout.fillWidth: true
            summary: root.jobsSummary
            summaryObjectName: "workJobsSummary"
            expanded: root.jobsExpanded
            accent: root.runningJobCount > 0 ? Theme.ghostAmber : Theme.foreground
            description: root.jobsExpanded
                ? "Collapse background jobs." : "Expand background jobs."
            onToggled: root.jobsExpanded = !root.jobsExpanded
        }

        ColumnLayout {
            id: jobsList
            objectName: "workJobsList"
            visible: jobsToggle.visible && root.jobsExpanded
            Layout.fillWidth: true
            spacing: Theme.gap / 2

            Repeater {
                model: Ghostd.workJobs

                delegate: ColumnLayout {
                    id: jobDelegate
                    required property var modelData
                    Layout.fillWidth: true
                    spacing: 2

                    DisclosureRow {
                        id: jobRow
                        objectName: "workJobRow-" + String(jobDelegate.modelData.id || "")
                        Layout.fillWidth: true
                        implicitHeight: Theme.controlHeight
                        summary: String(jobDelegate.modelData.label
                            || jobDelegate.modelData.command || "Background job")
                        expanded: root.outputExpanded(jobDelegate.modelData.id)
                        accent: Theme.foreground
                        description: root.outputExpanded(jobDelegate.modelData.id)
                            ? "Hide this job's output." : "Show this job's output."
                        customContent: true
                        onToggled: root.toggleOutput(jobDelegate.modelData.id)

                        RowLayout {
                            anchors.fill: parent
                            anchors.leftMargin: Theme.gap
                            anchors.rightMargin: Theme.gap
                            z: 1
                            spacing: Theme.gap

                            Text {
                                Layout.fillWidth: true
                                text: String(jobDelegate.modelData.label
                                    || jobDelegate.modelData.command || "Background job")
                                color: Theme.foreground
                                font.family: Theme.fontFamilyMono
                                font.pixelSize: Theme.fontSizeSmall
                                elide: Text.ElideRight
                            }

                            Text {
                                text: root.jobStatusName(jobDelegate.modelData)
                                color: root.jobStatusColor(jobDelegate.modelData.status)
                                font.family: Theme.fontFamily
                                font.pixelSize: Theme.fontSizeSmall
                                font.weight: jobDelegate.modelData.status === "running"
                                    ? Font.DemiBold : Font.Normal
                            }

                            Text {
                                text: root.duration(jobDelegate.modelData.durationMs)
                                    + (jobDelegate.modelData.status === "failed"
                                        && jobDelegate.modelData.exitCode !== undefined
                                        ? " · exit " + jobDelegate.modelData.exitCode : "")
                                color: Theme.foregroundDim
                                font.family: Theme.fontFamilyMono
                                font.pixelSize: Theme.fontSizeSmall
                            }

                            ActionButton {
                                objectName: "workJobCancel-" + String(jobDelegate.modelData.id || "")
                                visible: jobDelegate.modelData.status === "running"
                                label: "Cancel"
                                danger: true
                                enabled: !Ghostd.streaming && !Ghostd.workMutating
                                Accessible.description: "Cancel this background job."
                                onClicked: Ghostd.cancelWorkJob(jobDelegate.modelData.id)
                            }
                        }
                    }

                    ColumnLayout {
                        visible: root.outputExpanded(jobDelegate.modelData.id)
                            && (String(jobDelegate.modelData.output || "") !== ""
                                || jobDelegate.modelData.outputTruncated === true)
                        Layout.fillWidth: true
                        Layout.leftMargin: Theme.gap
                        Layout.rightMargin: Theme.gap
                        spacing: 2

                        Text {
                            objectName: "workJobOutput-" + String(jobDelegate.modelData.id || "")
                            Layout.fillWidth: true
                            text: String(jobDelegate.modelData.output || "")
                            color: Theme.foregroundDim
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall
                            textFormat: Text.PlainText
                            wrapMode: Text.WrapAnywhere
                            maximumLineCount: 12
                            elide: Text.ElideRight
                        }

                        Text {
                            visible: jobDelegate.modelData.outputTruncated === true
                            Layout.fillWidth: true
                            text: "…truncated"
                            color: Theme.foregroundFaint
                            font.family: Theme.fontFamilyMono
                            font.pixelSize: Theme.fontSizeSmall - 1
                        }
                    }
                }
            }
        }

        Text {
            id: errorLine
            objectName: "workErrorLine"
            visible: Ghostd.workError !== ""
            Layout.fillWidth: true
            text: Ghostd.workError
            color: Theme.ghostRose
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            wrapMode: Text.WordWrap
        }
    }
}
