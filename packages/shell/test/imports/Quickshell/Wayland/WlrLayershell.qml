import QtQml
import QtQuick

// The layer-shell window's QML surface, enough to compile overlays against.
// Tests have no screens, so none is ever instantiated.
QtObject {
    default property list<QtObject> data
    property var screen: null
    property bool visible: false
    property color color
    property real width: 0
    property real height: 0
    property real implicitWidth: 0
    property real implicitHeight: 0
    property int exclusionMode: 0
    property var mask: null
    property string namespace: ""
    property int layer: 0
    property int keyboardFocus: 0
    property EdgeAnchors anchors: EdgeAnchors {}
    property EdgeMargins margins: EdgeMargins {}
}
