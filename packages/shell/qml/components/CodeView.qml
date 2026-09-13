pragma ComponentBehavior: Bound

// A code file, read.
//
// Read-only is the v1 scope and it is a constraint, not an omission: live
// re-highlighting while typing needs access to the document's format runs
// (QSyntaxHighlighter, QTextCursor::setCharFormat), and QML exposes neither.
// The only colouring channel QML gives us is the rich text we hand the view,
// and re-parsing the whole file into HTML on every keystroke would rebuild the
// document — losing the cursor, the selection and the scroll position. Editing
// code belongs to the editor the user already has; this pane is for reading
// what the ghost is working on. Do not bolt editing on without a real
// document-format API.
//
// Two facts about Qt 6 rich text drive the layout, both measured (pinned in
// test/tst_codegutter.qml):
//
//   1. <pre> preserves runs of spaces and newlines and copies back as real
//      spaces, which no amount of &nbsp;/<br> rewriting would do as cleanly.
//   2. <pre> ignores the view's font.family — it forces the document's
//      fixed-pitch font — unless the block carries its own font-family. Given
//      one, its line metrics match a plain Text with the same family exactly,
//      which is what lets the gutter be a single cheap Text whose lines land on
//      the code's lines instead of one Item per line.
//
// The editor surface stays dark in light Omarchy themes; see Theme's editor
// tokens for why.
import QtQuick
import "../services"
import "Highlighter.js" as Highlighter

Item {
    id: root

    required property string source
    required property string filePath

    // CRLF would otherwise show up as a stray glyph per line, and a single
    // trailing newline would draw a phantom last line in the gutter.
    readonly property string body:
        root.source.replace(/\r\n/gu, "\n").replace(/\n$/u, "")

    // Tokenising megabytes on the UI thread would drop frames on open, and no
    // one reads a generated bundle in a HUD pane. Past the cap the file still
    // renders in full, just unhighlighted.
    readonly property bool oversize: root.body.length > 400000

    readonly property int lines: root.body === "" ? 1 : root.body.split("\n").length

    readonly property string family:
        Highlighter.safeFontFamily(Theme.fontFamilyMono, "monospace")

    readonly property string markup:
        "<pre style=\"font-family:'" + root.family
        + "'; font-size:" + Theme.fontSize + "px\">"
        + Highlighter.highlight(root.body, root.oversize ? "" : root.filePath, {
            comment: Theme.synComment,
            string: Theme.synString,
            number: Theme.synNumber,
            keyword: Theme.synKeyword,
            "function": Theme.synFunction
        })
        + "</pre>"

    function gutterLabels(): string {
        const out = [];
        for (let n = 1; n <= root.lines; n++) out.push(String(n));
        return out.join("\n");
    }

    implicitWidth: 420
    implicitHeight: 240

    Rectangle {
        anchors.fill: parent
        color: Theme.editorBackground

        Rectangle {
            id: gutter

            anchors.left: parent.left
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            width: numbers.implicitWidth + Theme.pad
            color: Theme.editorGutterBackground
            clip: true

            // Plain Text, so it is not selectable and never lands in a copy of
            // the code. It scrolls with the content vertically and stays put
            // horizontally, the way every editor gutter does.
            Text {
                id: numbers

                anchors.right: parent.right
                anchors.rightMargin: Theme.gap
                y: Theme.gap - flick.contentY
                text: root.gutterLabels()
                horizontalAlignment: Text.AlignRight
                color: Theme.editorGutterText
                font.family: root.family
                font.pixelSize: Theme.fontSize
            }

            Rectangle {
                anchors.right: parent.right
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                width: 1
                color: Theme.editorBorder
            }
        }

        Flickable {
            id: flick

            anchors.left: gutter.right
            anchors.right: parent.right
            anchors.top: parent.top
            anchors.bottom: parent.bottom
            clip: true
            contentWidth: code.contentWidth + Theme.pad * 2
            contentHeight: code.contentHeight + Theme.gap * 2
            boundsBehavior: Flickable.StopAtBounds

            // Code never wraps: a wrapped line and its neighbour would no
            // longer line up with the gutter, and indentation stops carrying
            // structure. Long lines scroll sideways instead.
            TextEdit {
                id: code

                x: Theme.gap
                y: Theme.gap
                readOnly: true
                selectByMouse: true
                textFormat: TextEdit.RichText
                wrapMode: TextEdit.NoWrap
                text: root.markup
                color: Theme.editorForeground
                selectionColor: Theme.editorSelection
                selectedTextColor: Theme.editorForeground
                font.family: root.family
                font.pixelSize: Theme.fontSize
            }
        }
    }
}
