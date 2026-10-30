import QtQuick
import "../services"

// A pane's header, the same in every pane: its name, a dim line under it
// saying what the pane is (or what went wrong), and the pane's own actions to
// the right. The rule beneath is the pane's, since where it falls depends on
// what the pane shows between them.
Item {
    id: root

    property string title
    property string subtitle
    property color subtitleColor: Theme.foregroundDim
    /** A subtitle wraps; a path or a status that must stay one line elides instead. */
    property int subtitleElide: Text.ElideNone
    default property alias actions: actionRow.data

    implicitHeight: Math.max(titles.implicitHeight, actionRow.implicitHeight)

    Column {
        id: titles
        anchors.left: parent.left
        anchors.right: actionRow.left
        anchors.rightMargin: Theme.gap
        spacing: Theme.gap / 2

        Text {
            width: parent.width
            text: root.title
            textFormat: Text.PlainText
            color: Theme.foregroundBright
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeHeading
            font.weight: Font.DemiBold
            elide: Text.ElideRight
        }

        Text {
            width: parent.width
            visible: root.subtitle !== ""
            text: root.subtitle
            textFormat: Text.PlainText
            color: root.subtitleColor
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            elide: root.subtitleElide
            wrapMode: root.subtitleElide === Text.ElideNone ? Text.WordWrap : Text.NoWrap
        }
    }

    Row {
        id: actionRow
        anchors.right: parent.right
        anchors.top: parent.top
        spacing: Theme.gap
    }
}
