// One transcript row: a user prompt, or a ghost's reply plus its tool trail.
//
// Assistant text renders as Text.MarkdownText — Qt 6 parses CommonMark
// natively, which covers everything a v1 reply needs (emphasis, code spans,
// lists, headings) without shipping a parser. User text renders plain so a
// prompt containing backticks or underscores survives verbatim.
import QtQuick
import qs.services

Item {
    id: root

    required property string speaker
    required property string body
    required property string toolTrail
    required property string failure
    required property bool busy

    readonly property bool mine: root.speaker === "user"

    implicitHeight: card.implicitHeight

    Rectangle {
        id: card

        anchors.right: root.mine ? parent.right : undefined
        anchors.left: root.mine ? undefined : parent.left
        width: Math.min(parent.width * (root.mine ? 0.82 : 1.0), implicitWidth + Theme.pad * 2)
        implicitWidth: Math.max(content.implicitWidth, 1) + Theme.pad * 2
        implicitHeight: content.implicitHeight + Theme.pad * 2
        radius: Theme.radius
        color: root.mine ? Theme.selection : Theme.surfaceDeep
        border.width: root.failure === "" ? 0 : 1
        border.color: Theme.danger

        Column {
            id: content
            anchors.fill: parent
            anchors.margins: Theme.pad
            spacing: Theme.gap / 2

            // The tool trail, when the ghost used any. Compact by design: the
            // names, in call order, not the arguments.
            Text {
                visible: root.toolTrail !== ""
                width: parent.width
                text: "⚒ " + root.toolTrail
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                elide: Text.ElideRight
            }

            Text {
                width: parent.width
                visible: root.body !== ""
                text: root.body
                textFormat: root.mine ? Text.PlainText : Text.MarkdownText
                color: root.mine ? Theme.foregroundBright : Theme.foreground
                // Monochrome links: the markdown renderer underlines them, so
                // link-ness reads from the underline, not a saturated colour
                // (the palette accent is blue). Restrained, per the design system.
                linkColor: Theme.foregroundBright
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
                wrapMode: Text.Wrap
                onLinkActivated: link => ExternalLinks.openModelUrl(link)
            }

            Text {
                visible: root.busy && root.body === ""
                text: "…"
                color: Theme.foregroundDim
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSize
            }

            Text {
                visible: root.failure !== ""
                width: parent.width
                text: root.failure
                color: Theme.danger
                font.family: Theme.fontFamily
                font.pixelSize: Theme.fontSizeSmall
                wrapMode: Text.Wrap
            }
        }
    }
}
