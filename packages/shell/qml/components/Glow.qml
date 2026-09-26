import QtQuick
import Qt5Compat.GraphicalEffects
import "../services"

// A soft round bloom: `core` at the centre, `mid` at `midAt`, transparent at
// the rim. Set `width`; it is always a circle. The radii are half the size on
// purpose: RadialGradient defaults them to the full width, so the falloff would
// still be mid-hue at the bounds and paint a hard-edged square. A non-zero
// `breath` dims the opacity to `breathLow` and back, `breath` ms each way.
RadialGradient {
    id: root

    property color core
    property color mid
    property real midAt: 0.5
    property real breathLow: 1
    property int breath: 0

    height: width
    horizontalRadius: width / 2
    verticalRadius: height / 2
    gradient: Gradient {
        GradientStop { position: 0.0; color: root.core }
        GradientStop { position: root.midAt; color: root.mid }
        GradientStop { position: 1.0; color: Qt.rgba(root.core.r, root.core.g, root.core.b, 0) }
    }

    SequentialAnimation on opacity {
        running: root.breath > 0 && !Theme.reducedMotion
        loops: Animation.Infinite
        NumberAnimation { to: root.breathLow; duration: root.breath; easing.type: Easing.InOutSine }
        NumberAnimation { to: 1.0; duration: root.breath; easing.type: Easing.InOutSine }
    }
}
