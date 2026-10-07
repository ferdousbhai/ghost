// ActivityLine — what the ghost is doing right now, beside the orb.
//
// This line reports; it does not perform. The runtime brackets every tool call
// with execution events, so there is a real sentence for almost every moment of
// a turn.
//
// The ladder, in order: the tool call that is running, rendered by the same
// ToolTrace the transcript cards use, then the state the runtime reported (a
// reasoning heading, a hook, the reply being written), then the call that
// last settled, in the past tense. The ghost's own text is not repeated
// here: each one is a message in the reading column (TurnBlocks.js).
// Nothing rotates: a line changes when the work changes, and
// the ellipsis is what says it is still going.
import QtQuick
import "../services"
import "ToolTrace.js" as ToolTrace

Item {
    id: root

    readonly property bool failing: !Ghostd.streaming && Ghostd.lastError !== ""
    property int ellipsisStep: 0

    /**
     * The call the ghost is inside of, or null between calls. Parallel calls
     * settle in any order, so the most recently opened one is the one this
     * line follows.
     */
    readonly property var liveTool: {
        const activities = Ghostd.toolActivities;
        for (let i = activities.length - 1; i >= 0; i--) {
            const status = activities[i].status;
            if (status !== "complete" && status !== "failed") return activities[i];
        }
        return null;
    }
    readonly property string toolLine: root.liveTool
        ? ToolTrace.text(root.liveTool, false, false, true) : ""
    readonly property var lastTool: Ghostd.toolActivities.length > 0
        ? Ghostd.toolActivities[Ghostd.toolActivities.length - 1] : null
    readonly property string phrase: root.toolLine !== "" ? root.toolLine
        : root.stateLine(Ghostd.activity)

    /**
     * The runtime's own word for a turn that is not inside a tool call, or the
     * name of the owner hook it is waiting on. A tool
     * name arriving here is not repeated — {@link toolLine} already said it,
     * with the arguments that make it mean something. Between calls with no
     * word of its own, the turn is still digesting the call that last settled.
     */
    function stateLine(activity: string): string {
        if (activity.startsWith("thinking:")) return root.thoughtLine(activity.slice(9));
        if (activity === "writing") return "Writing a reply";
        if (activity === "waiting for ghostd") return "Waiting for ghostd";
        if (activity.startsWith("starting:")) return "Starting " + activity.slice(9);
        if (activity.startsWith("hook:") && activity.length > 5) return activity.slice(5);
        if (root.lastTool)
            return ToolTrace.text(root.lastTool, true, root.lastTool.status === "failed", true);
        return "Working";
    }

    /**
     * The newest `**heading**` of the harness's reasoning, when it writes
     * summaries that way (codex, claude). Unheaded reasoning is prose, not a
     * status, so it reads as plain "Thinking".
     */
    function thoughtLine(thought: string): string {
        const headings = thought.match(/\*\*([^*\n]+)\*\*/g);
        return headings ? headings[headings.length - 1].slice(2, -2).trim() : "Thinking";
    }

    // The web original whispered its phrases in slate-300 at 80%. Light mode has
    // no such near-white to dim, so the neutral dim token carries the same role.
    readonly property color phraseColor: Theme.light
        ? Theme.foregroundDim : Qt.rgba(0.796, 0.835, 0.882, 0.8)

    // A long command or error wraps rather than eliding to one line; the cap
    // keeps a pasted script from pushing the composer off the pane.
    implicitHeight: visible ? Math.max(30, phraseText.implicitHeight + 8) : 0
    visible: Ghostd.working || root.failing
    clip: false

    // The phrase says what is happening; these say it is still happening.
    Timer {
        interval: 430
        repeat: true
        running: Ghostd.working && !Theme.reducedMotion
        onTriggered: root.ellipsisStep = (root.ellipsisStep + 1) % 4
    }

    Row {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.topMargin: 4
        spacing: Theme.gap

        Item {
            width: 22
            height: 22
            clip: false

            SpectralOrb {
                visible: Ghostd.working
                anchors.centerIn: parent
                diameter: 20
            }

            Rectangle {
                visible: root.failing
                anchors.centerIn: parent
                width: 6
                height: 6
                radius: 3
                color: Theme.ghostRose
            }
        }

        Text {
            id: phraseText
            width: Math.max(parent.width - 22 - Theme.gap, 0)
            text: root.failing
                ? Ghostd.lastError
                : root.phrase + (Theme.reducedMotion ? "…" : ".".repeat(root.ellipsisStep))
            color: root.failing ? Theme.ghostRose : root.phraseColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.weight: Font.Light
            font.letterSpacing: 0.5
            // Centre the first line on the orb, whatever the font height.
            topPadding: Math.max(0, (22 - contentHeight / Math.max(lineCount, 1)) / 2)
            wrapMode: Text.WrapAtWordBoundaryOrAnywhere
            maximumLineCount: 4
            elide: Text.ElideRight
        }
    }
}
