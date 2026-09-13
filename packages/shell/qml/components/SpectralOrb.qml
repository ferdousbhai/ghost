pragma ComponentBehavior: Bound

// SpectralOrb — the ghost, drawn the way this desktop draws everything else.
//
// It began as a QML port of summon-ghost's layered gradient orb (be07ca78) and
// kept its job: the one soft, luminous thing in a UI made of characters, cold
// spectral blue against the ghost's warm amber. What changed is the substrate.
// Omarchy rounds nothing and sets everything in a fixed-width face, so the orb
// is a phosphor matrix now — square cells on a square grid, bright at the core,
// falling off to the rim, with motes walking the outer ring one cell at a time.
// A CRT rather than a bloom.
//
// No two summonings look alike: OrbSeed derives the disc's falloff, its
// phosphor's place in the spectral band and its mote count from the ghost's
// name, and every cell's rhythm from the turn. See OrbSeed.js for why those are
// two seeds and not one.
//
// The generous paint box is inherited and still intentional: the bloom reaches
// past the logical diameter while the parent keeps a stable height.
import QtQuick
import Qt5Compat.GraphicalEffects
import "../services"
import "OrbSeed.js" as OrbSeed

Item {
    id: root

    property real diameter: 20
    property bool running: true
    /** Fixes the slow traits, so a ghost looks like itself across every turn. */
    property string ghost: ""
    /** Fixes the motion, so no two summonings flicker alike. */
    property string turnKey: ""

    // The caller's resolution, not the seed's: five columns is what fits at 20px
    // and three at 12px, and a grid the seed chose would make one ghost legible
    // and another a smudge.
    readonly property int grid: root.diameter >= 26 ? 7 : (root.diameter >= 16 ? 5 : 3)
    readonly property var params: OrbSeed.orb(root.ghost, root.turnKey, root.grid)
    readonly property real cell: root.diameter / root.grid
    // A cell with its gap taken out, floored so it never falls below a pixel.
    // The gap is most of what makes this read as a matrix rather than a lit
    // square: at 20px across five columns there is only a pixel and a half of
    // it, and any less closes the dots up into a blob.
    readonly property real pixel: Math.max(1, root.cell * 0.62)
    readonly property real inset: (root.cell - root.pixel) / 2

    // The ghost's own cold blue, moved within the spectral band by the ghost
    // seed. Fixed brand rather than a themed colour: the amber presence and this
    // are the two things that stay the ghost's across every Omarchy theme.
    readonly property color phosphor: {
        const base = Qt.color(Theme.spectral);
        return Qt.hsla(((base.hslHue * 360 + root.params.hueShift + 360) % 360) / 360,
            base.hslSaturation, base.hslLightness, 1);
    }

    implicitWidth: root.diameter
    implicitHeight: root.diameter
    clip: false

    // The bloom a phosphor dot leaves on the glass around it. Without it the
    // matrix reads as a chart rather than as something lit from behind.
    RadialGradient {
        anchors.centerIn: parent
        width: root.diameter * 2.4
        height: width
        horizontalRadius: width / 2
        verticalRadius: height / 2
        gradient: Gradient {
            GradientStop {
                position: 0.0
                color: Qt.rgba(root.phosphor.r, root.phosphor.g, root.phosphor.b, 0.34)
            }
            GradientStop {
                position: 0.45
                color: Qt.rgba(root.phosphor.r, root.phosphor.g, root.phosphor.b, 0.10)
            }
            GradientStop { position: 1.0; color: "transparent" }
        }

        SequentialAnimation on opacity {
            running: root.running && !Theme.reducedMotion
            loops: Animation.Infinite
            NumberAnimation { to: 0.5; duration: root.params.corePeriod * 2; easing.type: Easing.InOutSine }
            NumberAnimation { to: 1.0; duration: root.params.corePeriod * 2; easing.type: Easing.InOutSine }
        }
    }

    // The disc. Each cell holds its own rhythm rather than sharing a clock, so
    // the field shimmers instead of pulsing as one block — and every rhythm is
    // a declared animation, not a per-frame binding, because this runs in a HUD
    // that is open all day.
    Repeater {
        model: root.params.cells

        Rectangle {
            id: phosphorCell

            required property var modelData

            x: phosphorCell.modelData.column * root.cell + root.inset
            y: phosphorCell.modelData.row * root.cell + root.inset
            width: root.pixel
            height: root.pixel
            color: root.phosphor
            opacity: phosphorCell.modelData.brightness

            SequentialAnimation on opacity {
                running: root.running && !Theme.reducedMotion
                loops: Animation.Infinite
                NumberAnimation {
                    to: phosphorCell.modelData.brightness * phosphorCell.modelData.dim
                    duration: phosphorCell.modelData.period
                    easing.type: Easing.InOutSine
                }
                NumberAnimation {
                    to: phosphorCell.modelData.brightness
                    duration: phosphorCell.modelData.period
                    easing.type: Easing.InOutSine
                }
            }
        }
    }

    // Motes: a cell brighter than the disc under it, stepping around the rim.
    // Discrete because the grid is — a mote that slid between cells would be the
    // one thing on screen not made of them.
    Repeater {
        model: root.params.motes

        Rectangle {
            id: mote

            required property var modelData
            property int step: mote.modelData.step

            readonly property var seat: root.params.ring[
                ((mote.step % root.params.ring.length) + root.params.ring.length)
                % root.params.ring.length]

            x: mote.seat.column * root.cell + root.inset
            y: mote.seat.row * root.cell + root.inset
            width: root.pixel
            height: root.pixel
            // Brighter than the disc under it, not brighter than everything:
            // a mote is a cell that caught the beam, not a second light source.
            color: Qt.lighter(root.phosphor, 1.15)

            Timer {
                interval: mote.modelData.period
                repeat: true
                running: root.running && !Theme.reducedMotion
                onTriggered: mote.step += mote.modelData.clockwise ? 1 : -1
            }
        }
    }
}
