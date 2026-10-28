import QtQuick

// An xdg-toplevel's QML surface, enough for a window that holds Items: an Item
// so its children have a parent to anchor to. Tests never map it.
Item {
    property string title: ""
    property color color
    /** Never mapped, so never the active window. */
    readonly property Item contentItem: Item {}
    visible: false
}
