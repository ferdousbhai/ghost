// GhostGlyph — one lucide icon as a stroked Shape; by default lucide's
// "ghost", the app's mascot. Drawn in lucide's 24-unit box and scaled to
// `size`, so the 16px header presence dot and the 36px welcome hero are the
// same artwork rather than two hand-tuned drawings. `path` is the icon's SVG
// path data and `strokeWidth` stays in viewBox units, the numbers the icon set
// is specified in.
import QtQuick
import QtQuick.Shapes
import "../services"

Item {
    id: root

    property real size: 16
    property color tint: Theme.ghostAmber
    property real strokeWidth: 2
    // Body, scalloped hem, and two near-zero eye segments the round cap
    // renders as dots.
    property string path: "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8zM9 10h.01M15 10h.01"

    implicitWidth: root.size
    implicitHeight: root.size

    // The layer sits on the already-scaled Item, not on the 24×24 Shape:
    // layering the Shape would rasterise at 24px and then upscale, which is
    // exactly the blur this is meant to avoid at size 36.
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
            PathSvg { path: root.path }
        }
    }
}
