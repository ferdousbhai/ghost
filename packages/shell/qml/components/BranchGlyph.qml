// Lucide's git-branch icon, drawn as a stroked Shape so transcript actions do
// not depend on an icon font being installed on the machine.
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
            PathSvg { path: "M6 3v12M18 9a9 9 0 0 1-9 9" }
        }

        ShapePath {
            fillColor: "transparent"
            strokeColor: root.tint
            strokeWidth: root.strokeWidth
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: "M21 6a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0z" }
        }
    }
}
