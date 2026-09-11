pragma ComponentBehavior: Bound

// The conversation's loaded resources, said once at the top of the transcript
// the way pi says it at session start: a collapsed count, a click to see the
// rows, and anything not admitted called out where the reader already is.
// The daemon owns discovery; this only renders its snapshot.
import QtQuick
import qs.services

Item {
    id: root

    readonly property var snapshot: Ghostd.sessionResources
    readonly property var rows: !root.snapshot ? []
        : root.snapshot.skills.map(function (row) { return { kind: "skill", row: row }; })
            .concat(root.snapshot.mcpServers.map(function (row) { return { kind: "mcp", row: row }; }))
    readonly property var diagnostics: !root.snapshot ? []
        : root.snapshot.diagnostics.concat(root.snapshot.mcpDiagnostics)
    readonly property int notAdmitted: root.rows.filter(function (entry) {
        return entry.row.status !== "admitted";
    }).length + root.diagnostics.length
    readonly property bool shown: root.snapshot !== null
        && (root.rows.length > 0 || root.diagnostics.length > 0)
    property bool expanded: false

    function summary(): string {
        if (!root.snapshot) return "";
        const skills = root.snapshot.skills.filter(function (row) { return row.status === "admitted"; }).length;
        const servers = root.snapshot.mcpServers.filter(function (row) { return row.status === "admitted"; }).length;
        const parts = [];
        parts.push(skills + (skills === 1 ? " skill" : " skills"));
        parts.push(servers + (servers === 1 ? " MCP server" : " MCP servers"));
        return parts.join(" · ");
    }

    function statusColor(status: string): color {
        if (status === "admitted") return Theme.foregroundFaint;
        if (status === "shadowed" || status === "disabled") return Theme.warn;
        return Theme.danger;
    }

    function detail(row: var): string {
        if (typeof row.reason === "string" && row.reason !== "") return row.reason;
        if (typeof row.shadowedBy === "string" && row.shadowedBy !== "")
            return "shadowed by " + row.shadowedBy;
        return "";
    }

    implicitHeight: root.shown ? column.implicitHeight + Theme.gap : 0
    visible: root.shown

    Component.onCompleted: if (Ghostd.activeGhost !== "") Ghostd.fetchSessionResources(false)

    Connections {
        target: Ghostd

        function onActiveGhostChanged(): void {
            if (Ghostd.activeGhost !== "") Ghostd.fetchSessionResources(false);
        }

        function onCurrentSessionIdChanged(): void {
            if (Ghostd.activeGhost !== "") Ghostd.fetchSessionResources(false);
        }

        // Claude Code starts on the first turn, so the snapshot exists only
        // after one has finished; on pi this just re-reads a stable list.
        function onTurnFinished(ghost: string, text: string): void {
            if (ghost === Ghostd.activeGhost) Ghostd.fetchSessionResources(true);
        }
    }

    Column {
        id: column

        width: parent.width
        spacing: Theme.gap / 2

        Row {
            spacing: Theme.gap / 2

            Text {
                id: summaryText
                text: root.summary()
                textFormat: Text.PlainText
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
            }

            Text {
                visible: root.notAdmitted > 0
                text: "· " + root.notAdmitted + " not loaded"
                textFormat: Text.PlainText
                color: Theme.danger
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
            }

            Text {
                text: root.expanded ? "▾" : "▸"
                textFormat: Text.PlainText
                color: Theme.foregroundFaint
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeCaption
            }
        }

        Column {
            visible: root.expanded
            width: parent.width
            spacing: 2

            Repeater {
                model: root.expanded ? root.rows : []

                Text {
                    required property var modelData

                    width: parent.width
                    text: (modelData.kind === "mcp" ? "mcp " : "skill ") + modelData.row.name
                        + (modelData.row.status === "admitted" ? "" : " — " + modelData.row.status)
                        + (root.detail(modelData.row) !== "" ? " · " + root.detail(modelData.row) : "")
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: root.statusColor(modelData.row.status)
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                }
            }

            Repeater {
                model: root.expanded ? root.diagnostics : []

                Text {
                    required property var modelData

                    width: parent.width
                    text: (typeof modelData.path === "string" ? modelData.path + " — " : "") + modelData.reason
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: Theme.danger
                    font.family: Theme.fontFamily
                    font.pixelSize: Theme.fontSizeCaption
                }
            }
        }
    }

    MouseArea {
        anchors.fill: column
        cursorShape: Qt.PointingHandCursor
        onClicked: root.expanded = !root.expanded
        Accessible.role: Accessible.Button
        Accessible.name: root.expanded ? "Hide loaded resources" : "Show loaded resources"
    }
}
