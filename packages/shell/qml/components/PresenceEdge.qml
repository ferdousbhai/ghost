pragma ComponentBehavior: Bound

// PresenceEdge — one screen edge's glow, its own layer surface.
//
// Four thin surfaces, not one full-screen one: Qt repaints a whole window for
// any change, and the shimmer runs for as long as a turn does. Each takes no
// input (an empty mask) and reserves no space, so the desktop under it works
// as if it were not there. Where two edges meet the glows add up, which is
// the corner bloom.
import Quickshell
import Quickshell.Wayland
import QtQuick
import Qt5Compat.GraphicalEffects
import "../services"

WlrLayershell {
    id: root

    /** "top", "bottom", "left", or "right". */
    property string edge: "top"
    /** 0 is off; 1 is the summoned glow. The shimmer sits well below it. */
    property real strength: 0
    property real phase: 0

    readonly property bool horizontal: root.edge === "top" || root.edge === "bottom"
    readonly property int thickness: Math.max(1, Math.round(Theme.pad * 2.4 * root.strength))

    // Quickshell's typeinfo declares the edge anchors without their members.
    // qmllint disable missing-property
    anchors {
        top: root.edge !== "bottom"
        bottom: root.edge !== "top"
        left: root.edge !== "right"
        right: root.edge !== "left"
    }
    // qmllint enable missing-property
    implicitWidth: root.horizontal ? 0 : root.thickness
    implicitHeight: root.horizontal ? root.thickness : 0
    visible: root.strength > 0.01
    color: "transparent"
    exclusionMode: ExclusionMode.Ignore
    mask: Region {}
    namespace: "ghost-presence"
    layer: WlrLayer.Overlay
    keyboardFocus: WlrKeyboardFocus.None

    // A spectral band travels along the edge; a falloff mask fades it away
    // from the edge. Both are gradients on one small surface.
    readonly property bool fromStart: root.edge === "top" || root.edge === "left"

    Rectangle {
        id: band
        anchors.fill: parent
        visible: false
        gradient: Gradient {
            orientation: root.horizontal ? Gradient.Horizontal : Gradient.Vertical
            GradientStop { position: 0.0; color: Theme.spectral }
            GradientStop { position: (root.phase + 0.00) % 1; color: Theme.ghostAmber }
            GradientStop { position: (root.phase + 0.33) % 1; color: Theme.ghostRose }
            GradientStop { position: (root.phase + 0.66) % 1; color: Theme.spectral }
            GradientStop { position: 1.0; color: Theme.ghostAmber }
        }
    }

    Rectangle {
        id: falloff
        anchors.fill: parent
        visible: false
        gradient: Gradient {
            orientation: root.horizontal ? Gradient.Vertical : Gradient.Horizontal
            GradientStop { position: root.fromStart ? 0.0 : 1.0; color: Qt.rgba(0, 0, 0, 0.85) }
            GradientStop { position: root.fromStart ? 0.3 : 0.7; color: Qt.rgba(0, 0, 0, 0.38) }
            GradientStop { position: root.fromStart ? 0.65 : 0.35; color: Qt.rgba(0, 0, 0, 0.1) }
            GradientStop { position: root.fromStart ? 1.0 : 0.0; color: "transparent" }
        }
    }

    OpacityMask {
        anchors.fill: parent
        source: band
        maskSource: falloff
    }
}
