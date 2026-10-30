// CodeBlock — a fenced block of a reply, shown as code: a well recessed into
// the canvas, the language named quietly in its corner, the code in the
// theme's blue so it reads apart from the prose (everything here is the same
// monospace face, so face alone cannot). Long lines wrap rather than clip.
import QtQuick
import "../services"

Rectangle {
    id: root

    property string language: ""
    property string code: ""

    implicitHeight: codeText.implicitHeight + Theme.gap * 3
    color: Theme.well
    radius: Theme.controlRadius

    Text {
        id: codeText
        anchors.left: parent.left
        anchors.right: languageText.visible ? languageText.left : parent.right
        anchors.top: parent.top
        anchors.margins: Theme.gap * 1.5
        text: root.code
        textFormat: Text.PlainText
        color: Theme.info
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
        lineHeight: Theme.lineHeight
        wrapMode: Text.WrapAtWordBoundaryOrAnywhere
    }

    Text {
        id: languageText
        visible: root.language !== ""
        anchors.right: parent.right
        anchors.top: parent.top
        anchors.margins: Theme.gap * 1.5
        text: root.language
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSizeCaption
    }
}
