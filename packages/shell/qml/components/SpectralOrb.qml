// SpectralOrb — QML port of summon-ghost's mature layered orb (be07ca78).
// The generous paint box is intentional: the historical clipping fix kept the
// 2.5× aura outside the logical 20px orb while its parent retained stable height.
import QtQuick
import Qt5Compat.GraphicalEffects
import qs.services

Item {
    id: root

    property real diameter: 20
    property bool running: true

    implicitWidth: diameter
    implicitHeight: diameter
    clip: false

    // Soft aura, equivalent to the old 2.5× radial glow.
    RadialGradient {
        anchors.centerIn: parent
        width: root.diameter * 2.6
        height: width
        horizontalRadius: width / 2
        verticalRadius: height / 2
        opacity: 0.8
        gradient: Gradient {
            GradientStop { position: 0.0; color: "#80dceaff" }
            GradientStop { position: 0.42; color: "#35b4c8ff" }
            GradientStop { position: 1.0; color: "#00000000" }
        }

        SequentialAnimation on opacity {
            running: root.running && !Theme.reducedMotion
            loops: Animation.Infinite
            NumberAnimation { to: 0.42; duration: 1050; easing.type: Easing.InOutSine }
            NumberAnimation { to: 0.86; duration: 1050; easing.type: Easing.InOutSine }
        }
    }

    Item {
        id: outer
        anchors.centerIn: parent
        width: root.diameter
        height: width

        RadialGradient {
            anchors.fill: parent
            horizontalOffset: -root.diameter * 0.11
            verticalOffset: -root.diameter * 0.11
            horizontalRadius: width * 0.65
            verticalRadius: height * 0.65
            gradient: Gradient {
                GradientStop { position: 0.0; color: "#d9ecffff" }
                GradientStop { position: 0.45; color: "#79b4c8f0" }
                GradientStop { position: 0.78; color: "#36758fd1" }
                GradientStop { position: 1.0; color: "#00000000" }
            }
        }

        NumberAnimation on rotation {
            running: root.running && !Theme.reducedMotion
            from: 0; to: 360; duration: 6200
            loops: Animation.Infinite
            easing.type: Easing.Linear
        }
    }

    Item {
        id: middle
        anchors.centerIn: parent
        width: Math.max(4, root.diameter - 6)
        height: width

        RadialGradient {
            anchors.fill: parent
            horizontalOffset: -width * 0.08
            verticalOffset: -height * 0.08
            horizontalRadius: width * 0.65
            verticalRadius: height * 0.65
            gradient: Gradient {
                GradientStop { position: 0.0; color: "#f5ffffff" }
                GradientStop { position: 0.42; color: "#b8d2e1ff" }
                GradientStop { position: 0.76; color: "#618fa9e8" }
                GradientStop { position: 1.0; color: "#00000000" }
            }
        }

        SequentialAnimation on scale {
            running: root.running && !Theme.reducedMotion
            loops: Animation.Infinite
            NumberAnimation { to: 0.86; duration: 820; easing.type: Easing.InOutSine }
            NumberAnimation { to: 1.08; duration: 820; easing.type: Easing.InOutSine }
        }
    }

    RadialGradient {
        anchors.centerIn: parent
        width: Math.max(3, root.diameter - 12)
        height: width
        horizontalOffset: -width * 0.1
        verticalOffset: -height * 0.1
        horizontalRadius: width * 0.7
        verticalRadius: height * 0.7
        gradient: Gradient {
            GradientStop { position: 0.0; color: "#ffffffff" }
            GradientStop { position: 0.52; color: "#e8f2ffff" }
            GradientStop { position: 1.0; color: "#7ec8dcff" }
        }

        SequentialAnimation on opacity {
            running: root.running && !Theme.reducedMotion
            loops: Animation.Infinite
            NumberAnimation { to: 0.68; duration: 430; easing.type: Easing.InOutQuad }
            NumberAnimation { to: 1.0; duration: 610; easing.type: Easing.InOutQuad }
        }
    }

    Item {
        anchors.centerIn: parent
        width: root.diameter
        height: width
        Rectangle {
            anchors.horizontalCenter: parent.horizontalCenter
            y: -1
            width: 3.5; height: 3.5; radius: width / 2
            color: "#f0fff8e4"
        }
        NumberAnimation on rotation {
            running: root.running && !Theme.reducedMotion
            from: 0; to: 360; duration: 2100
            loops: Animation.Infinite; easing.type: Easing.Linear
        }
    }

    Item {
        anchors.centerIn: parent
        width: root.diameter
        height: width
        Rectangle {
            anchors.verticalCenter: parent.verticalCenter
            x: 0
            width: 2.5; height: 2.5; radius: width / 2
            color: "#cce8f5ff"
        }
        NumberAnimation on rotation {
            running: root.running && !Theme.reducedMotion
            from: 360; to: 0; duration: 3300
            loops: Animation.Infinite; easing.type: Easing.Linear
        }
    }

    Item {
        anchors.centerIn: parent
        width: root.diameter
        height: width
        Rectangle {
            x: parent.width - 3
            y: parent.height - 3
            width: 2; height: 2; radius: 1
            color: "#bfffffff"
        }
        NumberAnimation on rotation {
            running: root.running && !Theme.reducedMotion
            from: 0; to: 360; duration: 4700
            loops: Animation.Infinite; easing.type: Easing.Linear
        }
    }
}
