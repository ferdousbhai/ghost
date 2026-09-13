// ActivityLine — what the ghost is doing right now, beside the orb.
//
// This line reports; it does not perform. Its predecessor rotated invented
// spectral phrases every three seconds ("Coaxing the haunted mist") because it
// had nothing real to say: `activity` clears between every tool lifecycle
// event, so the copy needed a held key and a beat just to stop flickering. Both
// runtimes now bracket every call with tool execution events, so there is a
// real sentence available for almost every moment of a turn — and a real one
// outranks any invented one.
//
// The ladder, in order: the tool call that is running, rendered by the same
// ToolTrace the transcript cards use, then the plain state the runtime
// reported. The ghost's own narration is not repeated here: it streams in the
// reading column, where the next text overwrites it (TurnBlocks.js). Nothing
// rotates: a line changes when the work changes, and the ellipsis is what says
// it is still going.
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
        ? ToolTrace.text(root.liveTool, false, false, false) : ""
    readonly property string phrase: root.toolLine !== "" ? root.toolLine
        : root.stateLine(Ghostd.activity)

    /**
     * The runtime's own word for a turn that is not inside a tool call. A tool
     * name arriving here is not repeated — {@link toolLine} already said it,
     * with the arguments that make it mean something.
     */
    function stateLine(activity: string): string {
        if (activity.startsWith("switching model · "))
            return "Switching to " + activity.slice("switching model · ".length);
        if (activity.startsWith("using fallback · "))
            return "Falling back to " + activity.slice("using fallback · ".length);
        if (activity === "thinking") return "Thinking";
        if (activity === "waiting for ghostd") return "Waiting for ghostd";
        return "Working";
    }

    // The web original whispered its phrases in slate-300 at 80%. Light mode has
    // no such near-white to dim, so the neutral dim token carries the same role.
    readonly property color phraseColor: Theme.light
        ? Theme.foregroundDim : Qt.rgba(0.796, 0.835, 0.882, 0.8)

    implicitHeight: visible ? 30 : 0
    visible: Ghostd.streaming || root.failing
    clip: false

    // The phrase says what is happening; these say it is still happening.
    Timer {
        interval: 430
        repeat: true
        running: Ghostd.streaming && !Theme.reducedMotion
        onTriggered: root.ellipsisStep = (root.ellipsisStep + 1) % 4
    }

    Row {
        anchors.left: parent.left
        anchors.right: parent.right
        anchors.verticalCenter: parent.verticalCenter
        spacing: Theme.gap

        Item {
            width: 22
            height: 22
            clip: false

            SpectralOrb {
                visible: Ghostd.streaming
                anchors.centerIn: parent
                diameter: 20
                running: Ghostd.streaming
                ghost: Ghostd.activeGhost
                // One turn, one orb. The assistant row advances once per turn,
                // which is exactly the grain this wants.
                turnKey: Ghostd.currentSessionId + ":" + Ghostd.assistantRow
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
            anchors.verticalCenter: parent.verticalCenter
            width: Math.max(parent.width - 22 - Theme.gap, 0)
            text: root.failing
                ? Ghostd.lastError
                : root.phrase + (Theme.reducedMotion ? "…" : ".".repeat(root.ellipsisStep))
            color: root.failing ? Theme.ghostRose : root.phraseColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
            font.weight: Font.Light
            font.letterSpacing: 0.5
            elide: Text.ElideRight
        }
    }
}
