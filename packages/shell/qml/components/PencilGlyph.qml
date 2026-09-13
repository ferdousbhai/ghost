// Lucide's pencil icon, drawn locally for the same predictable rendering as
// the ghost and copy glyphs.
import QtQuick
import QtQuick.Shapes
import "../services"

Item {
    id: root

    property real size: 16
    property color tint: Theme.foregroundFaint
    property real strokeWidth: 2

    implicitWidth: root.size
    implicitHeight: root.size

    layer.enabled: true
    layer.samples: 4

    Shape {
        width: 24
        height: 24
        antialiasing: true
        transform: Scale {
            xScale: root.size / 24
            yScale: root.size / 24
        }

        ShapePath {
            fillColor: "transparent"
            strokeColor: root.tint
            strokeWidth: root.strokeWidth
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg {
                path: "M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497zM15 5l4 4"
            }
        }
    }
}
