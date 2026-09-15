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
// carried by its tint and by the orb that glows behind it while a turn runs,
// not by a separate indicator.
import QtQuick
import QtQuick.Controls
import "services"
import "components"

Item {
    id: root

    /**
     * Injected by the host, the same capability-scoped facade the panel and
     * service get. Clicking the mascot toggles this plugin's own window
     * through it; the signal stays for a caller that wants to do something
     * else with the click.
     */
    property var shell: null

    /**
     * The bar host, injected into any slot item that declares it. It carries
     * the geometry every widget has to match: `barSize` is the thickness the
     * host's own icon buttons take along the bar's cross axis, and `vertical`
     * says which axis that is.
     */
    property var bar: null

    readonly property string selfId: "ferdousbhai.ghost"

    signal activated()

    function toggleWindow(): void {
        if (root.shell && root.shell.toggle) root.shell.toggle(root.selfId, "{}");
        root.activated();
    }

    readonly property string status: !Ghostd.reachable
        ? "offline"
        : (Ghostd.streaming ? (Ghostd.activity !== "" ? Ghostd.activity : "thinking") : "idle")

    // Unreachable is the one state worth a colour of its own. Otherwise the
    // ghost wears its own amber, brightened while it is working.
    readonly property color markTint: !Ghostd.reachable
        ? Theme.danger
        : (Ghostd.streaming ? Theme.ghostAmberBright : Theme.ghostAmber)

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

        // Behind the mascot, and only while a turn runs: the same orb the
        // HUD shows, seeded per ghost and per turn so two ghosts do not
        // shimmer alike.
        SpectralOrb {
            visible: Ghostd.streaming && Ghostd.reachable
            anchors.centerIn: parent
            diameter: 14
            running: visible
            ghost: Ghostd.activeGhost
            turnKey: Ghostd.currentSessionId + ":" + Ghostd.assistantRow
        }

        GhostGlyph {
            anchors.centerIn: parent
            size: 14
            tint: root.markTint
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
        onClicked: root.toggleWindow()

        // The name the bar no longer spends space on, on demand.
        ToolTip.visible: hover.containsMouse
        ToolTip.text: (Ghostd.activeGhost === "" ? "ghost" : Ghostd.activeGhost)
            + " · " + root.status
    }
}
