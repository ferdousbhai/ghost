// GhostBarWidget — the ghost mascot, sized for Omarchy's bar. This is the
// plugin's `bar-widget` entry point.
//
// The mark alone, no name: bar space is shared with every other widget, and
// the ghost's name is one hover away in the tooltip and always on screen in
// the window itself. The mascot is what has to be recognisable at 14px.
//
// It runs in the same process as the panel, so it reads the same Ghostd
// singleton the window does: the glyph reacts the instant a turn starts, with
// no polling and no second connection to the daemon.
//
// The mark is GhostGlyph, the same lucide ghost the HUD's header and hero draw,
// so the bar and the window are one piece of artwork at two sizes. State is
// carried by the ghost itself, in herdr's agent-state language so the desktop
// reads one way: an outline in green when everything is read (idle), filled
// amber while a turn runs (working), filled blue when a reply is unread
// (done), filled red when the ghost is waiting on the owner's answer
// (blocked), and a dim outline while ghostd is unreachable. The state covers
// every conversation of the selected ghost, not just the one on screen.
import QtQuick
import "services"
import "services/Plugin.js" as Plugin
import "components"

Item {
    id: root

    /**
     * The bar host, injected into any slot item that declares it. It carries
     * the geometry every widget has to match: `barSize` is the thickness the
     * host's own icon buttons take along the bar's cross axis, and `vertical`
     * says which axis that is.
     */
    property var bar: null

    readonly property string selfId: Plugin.ID

    function triggerPress(button: int): void {
        if (button !== Qt.LeftButton || !root.bar) return;
        root.bar.hideTooltip(root);
        root.noteClick();
        if (root.bar.shell) root.bar.shell.toggle(root.selfId, '{"section":"home"}');
    }

    /** Where on the screen's edge the mark sits, so the menu's glow starts from it. */
    function noteClick(): void {
        const screen = root.Screen;
        if (screen.name === "" || screen.width <= 0 || screen.height <= 0) return;
        const edge = typeof root.bar.position === "string" ? root.bar.position : "top";
        const centre = root.mapToItem(null, root.width / 2, root.height / 2);
        const horizontal = edge === "top" || edge === "bottom";
        const at = horizontal ? centre.x / screen.width : centre.y / screen.height;
        Presence.clickedAt = { screen: screen.name, edge: edge, at: Math.max(0, Math.min(1, at)), time: Date.now() };
    }

    /** herdr's states, most urgent first: "offline", "blocked", "working", "done", or "idle". */
    readonly property string agentState: {
        if (!Ghostd.reachable) return "offline";
        const sessions = Ghostd.sessions;
        if (sessions.some(session => session && session.question)) return "blocked";
        if (Ghostd.anyStreaming || sessions.some(session => session && session.running)) return "working";
        if (sessions.some(session => session && session.unread)) return "done";
        return "idle";
    }

    readonly property string status: root.agentState === "blocked" ? "waiting for you"
        : root.agentState === "done" ? "unread reply"
        : root.agentState === "working"
            ? (Ghostd.working && Ghostd.activity !== "" ? Ghostd.activity.replace(/^(thinking|starting):[^]*/, "$1") : "working")
        : root.agentState

    readonly property string tooltipText: (Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost)
        + " · " + root.status
    readonly property bool tooltipHovered: visible && enabled && hover.containsMouse

    onTooltipTextChanged: {
        if (root.bar && root.tooltipHovered) root.bar.showTooltip(root, root.tooltipText);
    }
    onTooltipHoveredChanged: {
        if (!root.bar) return;
        if (root.tooltipHovered) root.bar.showTooltip(root, root.tooltipText);
        else root.bar.hideTooltip(root);
    }
    Component.onDestruction: if (root.bar) root.bar.hideTooltip(root)

    readonly property color markTint: root.agentState === "blocked" ? Theme.danger
        : root.agentState === "working" ? Theme.warn
        : root.agentState === "done" ? Theme.info
        : root.agentState === "idle" ? Theme.ok
        : Theme.foregroundDim

    Accessible.role: Accessible.Button
    Accessible.name: Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost
    Accessible.description: root.status

    // The bar lays its modules out in a plain Row, which positions x and
    // leaves y alone: a slot shorter than its neighbours rides at the top of
    // the bar instead of on their centre line. So the widget claims a full
    // host slot — the bar's own thickness across, the icon slot along — and
    // centres the mark inside it. Nothing here is ours to choose.
    readonly property bool vertical: root.bar ? root.bar.vertical : false
    readonly property real thickness: root.bar ? root.bar.barSize : 26
    // Style.bar.iconSlot, the length the host's icon buttons reserve along the
    // bar. Only qs.Commons has the token, and that import would bind this
    // plugin to the host's internals for one number.
    readonly property real slotLength: 27

    implicitWidth: root.vertical ? root.thickness : root.slotLength
    implicitHeight: root.vertical ? root.slotLength : root.thickness

    Item {
        anchors.centerIn: parent
        width: 16
        height: 16
        // The orb's bloom reaches past the glyph's box on purpose.
        clip: false

        GhostGlyph {
            objectName: "barMark"
            anchors.centerIn: parent
            size: 14
            tint: root.markTint
            filled: root.agentState !== "idle" && root.agentState !== "offline"
            // A hairline heavier than the HUD's: at 14px in a bar the
            // stroke has to survive the panel's own contrast.
            strokeWidth: 2.2

            // Offline is a state to notice, not to shout about: the mascot
            // dims rather than blinking.
            opacity: Ghostd.reachable ? 1 : 0.72
            Behavior on opacity {
                NumberAnimation { duration: 160; easing.type: Easing.OutCubic }
            }
        }
    }

    MouseArea {
        id: hover
        anchors.fill: parent
        cursorShape: Qt.PointingHandCursor
        acceptedButtons: Qt.LeftButton
        hoverEnabled: true
        onClicked: mouse => root.triggerPress(mouse.button)
    }
}
