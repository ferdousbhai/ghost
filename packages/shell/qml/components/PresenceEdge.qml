pragma ComponentBehavior: Bound

// PresenceEdge — one screen edge's stretch of the glow ring, its own layer
// surface.
//
// Four thin surfaces, not one full-screen one: Qt repaints a whole window for
// any change, and the colours flow for as long as the glow is up. Each takes
// no input (an empty mask) and reserves no space, so the desktop under it
// works as if it were not there. Where two edges meet the glows add up, which
// is the corner bloom. The surface keeps one size while it is up; how far the
// glow reaches into the screen changes inside it, so no frame resizes a
// surface.
import Quickshell
import Quickshell.Wayland
import QtQuick
import Qt5Compat.GraphicalEffects
import "../services"
import "../services/EdgeGlow.js" as EdgeGlow

WlrLayershell {
    id: root

    /** "top", "bottom", "left", or "right". */
    property string edge: "top"
    /** 0 is off; 1 is the summoned glow. The menu's and a working turn's sit below it. */
    property real strength: 0
    /** The colours' turn around the ring, 0..1. */
    property real phase: 0
    /** The ignition: where on the ring it started, how far it has reached (0..1), and its heads' brightness. */
    property real from: 0
    property real front: 1
    property real flare: 0
    /** The colours flowing round the ring. */
    property var palette: [Theme.ghostAmber, Theme.ghostRose, Theme.info, Theme.spectral]

    readonly property bool horizontal: root.edge === "top" || root.edge === "bottom"
    readonly property real length: root.horizontal ? root.screen.width : root.screen.height
    readonly property real perimeter: 2 * (root.screen.width + root.screen.height)
    /** How far into the screen the glow reaches, as a share of the surface; a flare reaches further. */
    readonly property real reach: Math.min(1, root.strength + root.flare * 0.5)

    // Quickshell's typeinfo declares the edge anchors without their members.
    // qmllint disable missing-property
    anchors {
        top: root.edge !== "bottom"
        bottom: root.edge !== "top"
        left: root.edge !== "right"
        right: root.edge !== "left"
    }
    // qmllint enable missing-property
    implicitWidth: root.horizontal ? 0 : Math.round(Theme.pad * 2.4)
    implicitHeight: root.horizontal ? Math.round(Theme.pad * 2.4) : 0
    visible: root.reach > 0.01
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    mask: Region {}
    namespace: "ghost-presence"
    layer: WlrLayer.Overlay
    keyboardFocus: WlrKeyboardFocus.None

    readonly property bool fromStart: root.edge === "top" || root.edge === "left"

    // The ring's colours along this edge, sampled at fixed stops and painted
    // whenever the colours turn or the ignition moves.
    readonly property int samples: 16
    property list<GradientStop> stops

    Component {
        id: stopComponent
        GradientStop {}
    }

    Component.onCompleted: {
        // Parented to the gradient: a stop tells its parent when its colour changes.
        const made = [];
        for (let i = 0; i < root.samples; i++)
            made.push(stopComponent.createObject(band.gradient, { position: i / (root.samples - 1) }));
        root.stops = made;
        band.gradient.stops = made;
        root.paint();
    }

    function paint(): void {
        if (!root.visible || root.stops.length === 0) return;
        for (let i = 0; i < root.stops.length; i++) {
            const s = EdgeGlow.ringAt(root.edge, i / (root.samples - 1) * root.length, root.screen.width, root.screen.height);
            root.stops[i].color = EdgeGlow.glowAt(s, root.perimeter, root.from, root.front, root.flare, root.phase, root.palette);
        }
    }

    onPhaseChanged: root.paint()
    onFrontChanged: root.paint()
    onFlareChanged: root.paint()
    onFromChanged: root.paint()
    onVisibleChanged: root.paint()

    Rectangle {
        id: band
        anchors.fill: parent
        visible: false
        gradient: Gradient {
            orientation: root.horizontal ? Gradient.Horizontal : Gradient.Vertical
        }
    }

    // Strongest at the screen's edge, gone by `reach` of the way in.
    Rectangle {
        id: falloff
        anchors.fill: parent
        visible: false
        gradient: Gradient {
            orientation: root.horizontal ? Gradient.Vertical : Gradient.Horizontal
            GradientStop { position: root.fromStart ? 0.0 : 1.0; color: Qt.rgba(0, 0, 0, 0.85) }
            GradientStop { position: root.fromStart ? 0.3 * root.reach : 1 - 0.3 * root.reach; color: Qt.rgba(0, 0, 0, 0.38) }
            GradientStop { position: root.fromStart ? 0.65 * root.reach : 1 - 0.65 * root.reach; color: Qt.rgba(0, 0, 0, 0.1) }
            GradientStop { position: root.fromStart ? root.reach : 1 - root.reach; color: "transparent" }
        }
    }

    OpacityMask {
        anchors.fill: parent
        source: band
        maskSource: falloff
    }
}
