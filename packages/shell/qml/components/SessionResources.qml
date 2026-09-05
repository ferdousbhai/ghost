pragma ComponentBehavior: Bound

// Read-only evidence of the resources admitted to the active principal
// session. The daemon owns discovery and precedence; this pane only renders
// its immutable snapshot.
import QtQuick
import qs.services

Rectangle {
    id: root

    readonly property var snapshot: Ghostd.sessionResources
    readonly property var skills: root.snapshot ? root.snapshot.skills : []
    readonly property var mcpServers: root.snapshot ? root.snapshot.mcpServers : []
    readonly property var diagnostics: root.snapshot
        ? root.snapshot.diagnostics.concat(root.snapshot.mcpDiagnostics) : []

    implicitWidth: Theme.pad * 48
    implicitHeight: Theme.pad * 34
    color: Theme.background
    clip: true

    function statusColor(status: string): color {
        if (status === "admitted") return Theme.ok;
        if (status === "shadowed" || status === "disabled") return Theme.warn;
        return Theme.danger;
    }

    function statusFill(status: string): color {
        if (status === "admitted") return Qt.rgba(Theme.ok.r, Theme.ok.g, Theme.ok.b, 0.10);
        if (status === "shadowed" || status === "disabled")
            return Qt.rgba(Theme.warn.r, Theme.warn.g, Theme.warn.b, 0.10);
        return Theme.rose(0.10);
    }

    function sourceLabel(row: var): string {
        return String(row.source) + " · precedence " + String(row.precedence);
    }

    function detail(row: var): string {
        if (typeof row.reason === "string" && row.reason !== "") return row.reason;
        if (typeof row.shadowedBy === "string" && row.shadowedBy !== "")
            return "Shadowed by " + row.shadowedBy;
        return "";
    }

    Component.onCompleted: if (Ghostd.activeGhost !== "") Ghostd.fetchSessionResources(false)
    onVisibleChanged: if (root.visible && Ghostd.activeGhost !== "")
        Ghostd.fetchSessionResources(false)

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            if (root.visible && Ghostd.activeGhost !== "")
                Ghostd.fetchSessionResources(false);
        }

        function onCurrentSessionIdChanged(): void {
            if (root.visible && Ghostd.activeGhost !== "")
                Ghostd.fetchSessionResources(false);
        }

        function onTurnFinished(ghost: string, text: string): void {
            if (root.visible && ghost === Ghostd.activeGhost)
                Ghostd.fetchSessionResources(true);
        }
    }

    component StatusBadge: Rectangle {
        required property string status

        implicitWidth: badgeText.implicitWidth + Theme.gap
        implicitHeight: badgeText.implicitHeight + 4
        radius: Theme.radius / 2
        color: root.statusFill(status)
        border.width: 1
        border.color: root.statusColor(status)

        Text {
            id: badgeText
            anchors.centerIn: parent
            text: parent.status
            textFormat: Text.PlainText
            color: root.statusColor(parent.status)
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeCaption
            font.weight: Font.DemiBold
            font.capitalization: Font.AllUppercase
        }
    }

    component SectionLabel: Text {
        required property string label

        width: parent ? parent.width : 0
        text: label
        textFormat: Text.PlainText
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeCaption
        font.weight: Font.DemiBold
        font.capitalization: Font.AllUppercase
        font.letterSpacing: 1
    }

    component ResourceRow: Rectangle {
        id: resourceRow

        required property var resource
        required property bool mcp

        width: parent ? parent.width : 0
        height: resourceCopy.implicitHeight + Theme.pad
        radius: Theme.radius
        color: Theme.film(0.035)
        border.width: 1
        border.color: Theme.border

        Column {
            id: resourceCopy
            anchors.left: parent.left
            anchors.leftMargin: Theme.pad / 2
            anchors.right: parent.right
            anchors.rightMargin: Theme.pad / 2
            anchors.verticalCenter: parent.verticalCenter
            spacing: Theme.gap / 3

            Row {
                width: parent.width
                spacing: Theme.gap

                Text {
                    width: parent.width - resourceStatus.width - parent.spacing
                    text: String(resourceRow.resource.name)
                    textFormat: Text.PlainText
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamilyMono
                    font.pixelSize: Theme.fontSize
                    font.weight: Font.DemiBold
                    elide: Text.ElideRight
                }

                StatusBadge {
                    id: resourceStatus
                    status: String(resourceRow.resource.status)
                }
            }

            Text {
                width: parent.width
                text: root.sourceLabel(resourceRow.resource)
                    + (resourceRow.mcp
                        ? (resourceRow.resource.enabled ? " · enabled" : " · not enabled") : "")
                textFormat: Text.PlainText
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
            }

            Text {
                width: parent.width
                text: String(resourceRow.resource.path)
                textFormat: Text.PlainText
                color: Theme.foregroundFaint
                font.family: Theme.fontFamilyMono
                font.pixelSize: Theme.fontSizeCaption
                wrapMode: Text.WrapAnywhere
            }

            Text {
                width: parent.width
                visible: text !== ""
                text: root.detail(resourceRow.resource)
                textFormat: Text.PlainText
                color: resourceRow.resource.status === "skipped"
                    ? Theme.danger : Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.WordWrap
            }
        }
    }

    Column {
        id: header
        anchors.left: parent.left
        anchors.leftMargin: Theme.pad
        anchors.right: parent.right
        anchors.rightMargin: Theme.pad
        anchors.top: parent.top
        anchors.topMargin: Theme.pad
        spacing: Theme.gap / 3

        Row {
            width: parent.width
            spacing: Theme.gap

            Column {
                width: parent.width - refreshButton.width - Theme.gap
                spacing: Theme.gap / 3

                Text {
                    width: parent.width
                    text: "Session resources"
                    textFormat: Text.PlainText
                    color: Theme.foregroundBright
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeHeading
                    font.weight: Font.DemiBold
                }

                Text {
                    width: parent.width
                    text: "The exact skills and MCP configuration this conversation admitted."
                    textFormat: Text.PlainText
                    color: Theme.foregroundDim
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            ActionButton {
                id: refreshButton
                label: Ghostd.sessionResourcesLoading ? "Refreshing" : "Refresh"
                enabled: Ghostd.activeGhost !== "" && !Ghostd.sessionResourcesLoading
                onClicked: Ghostd.fetchSessionResources(true)
            }
        }
    }

    Rectangle {
        id: headerRule
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: header.bottom
        anchors.topMargin: Theme.pad
        height: 1
        color: Theme.border
    }

    Flickable {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: headerRule.bottom
        anchors.bottom: parent.bottom
        contentWidth: width
        contentHeight: Math.max(height, contents.implicitHeight + Theme.pad * 2)
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: contents
            x: Theme.pad
            y: Theme.pad
            width: parent.width - Theme.pad * 2
            spacing: Theme.sectionGap

            Rectangle {
                width: parent.width
                height: errorText.implicitHeight + Theme.pad
                visible: Ghostd.sessionResourcesError !== ""
                radius: Theme.radius
                color: Theme.rose(0.08)
                border.width: 1
                border.color: Theme.rose(0.18)

                Text {
                    id: errorText
                    anchors.left: parent.left
                    anchors.leftMargin: Theme.pad / 2
                    anchors.right: parent.right
                    anchors.rightMargin: Theme.pad / 2
                    anchors.verticalCenter: parent.verticalCenter
                    text: Ghostd.sessionResourcesError
                    textFormat: Text.PlainText
                    color: Theme.danger
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeSmall
                    wrapMode: Text.WordWrap
                }
            }

            Text {
                width: parent.width
                visible: Ghostd.sessionResourcesLoading && root.snapshot === null
                text: "Reading the session snapshot…"
                textFormat: Text.PlainText
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSubtitle
                horizontalAlignment: Text.AlignHCenter
            }

        }
    }
}
