// Lucide's copy icon, drawn locally for the same predictable rendering as the
// ghost and pencil glyphs.
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
                path: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4"
            }
        }
    }
}
