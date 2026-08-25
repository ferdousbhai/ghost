// Lucide's message-square-plus icon, drawn as a stroked Shape so transcript
// actions do not depend on an icon font being installed on the machine.
import QtQuick
import QtQuick.Shapes
import qs.services

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
                path: "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z"
            }
        }

        ShapePath {
            fillColor: "transparent"
            strokeColor: root.tint
            strokeWidth: root.strokeWidth
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: "M12 8v6M9 11h6" }
        }
    }
}
