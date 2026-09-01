pragma ComponentBehavior: Bound

// Conversation-scoped background jobs that live beyond one model turn.
// Mutations stay in Ghostd; this component owns disclosure state and polling.
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

    property bool jobsExpanded: false
    property var expandedOutputs: ({})

    readonly property int runningJobCount: root.countJobs("running")
    readonly property int settledJobCount: Ghostd.workJobs.length - root.runningJobCount
    readonly property string jobsSummary: "Jobs · " + root.runningJobCount
        + " running · " + root.settledJobCount + " done"

    visible: Ghostd.workHasContent
    implicitHeight: visible ? content.implicitHeight + Theme.gap * 2 : 0
    radius: Theme.radius
    color: Theme.surfaceDeep
    border.width: 1
    border.color: Theme.border
    clip: true

    function countJobs(status: string): int {
        if (status === "running") return Ghostd.workRunningJobCount;
        return (Ghostd.workJobs || []).filter(function (job) {
            return job && job.status === status;
        }).length;
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
                            font.pixelSize: Theme.fontSizeCaption
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
