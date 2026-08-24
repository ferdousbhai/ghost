import QtQuick
import QtTest
import "../qml/components/Highlighter.js" as Highlighter

// CodeView's gutter is one Text, not one Item per line, and that only works
// because a <pre> block carrying an explicit font-family lays out with exactly
// the same line metrics as a plain Text using that family. Nothing in our code
// would catch Qt changing its mind about that: the numbers would simply drift
// out of line with the code beside them. Three Qt behaviours are pinned here.
//
// CodeView itself needs the `qs` module that only Quickshell synthesises, so
// the contract is pinned on the bare TextEdit/Text pair it is built from.
TestCase {
    id: tc
    name: "CodeGutter"
    when: windowShown
    width: 400
    height: 300
    visible: true

    readonly property string family: "DejaVu Sans Mono"
    readonly property int size: 13

    readonly property string body:
        "def f(x):\n"
        + "    return 1\n"
        + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n"
        + "last"

    TextEdit {
        id: code
        y: 400
        width: 200
        height: 120
        readOnly: true
        selectByMouse: true
        textFormat: TextEdit.RichText
        wrapMode: TextEdit.NoWrap
        topPadding: 0
        leftPadding: 0
        bottomPadding: 0
        font.family: tc.family
        font.pixelSize: tc.size
        text: "<pre style=\"font-family:'" + tc.family + "'; font-size:" + tc.size + "px\">"
            + Highlighter.highlight(tc.body, "a.py", {
                comment: "#5f8c69",
                string: "#d99a6c",
                number: "#b5cea8",
                keyword: "#9d8cf5",
                "function": "#d9c98a"
            })
            + "</pre>"
    }

    Text {
        id: gutter
        y: 700
        font.family: tc.family
        font.pixelSize: tc.size
        horizontalAlignment: Text.AlignRight
        text: "1\n2\n3\n4"
    }

    // A <pre> with no font-family of its own: the fixed-pitch fallback, which
    // is what CodeView must never emit.
    TextEdit {
        id: bare
        y: 1000
        width: 200
        height: 120
        readOnly: true
        textFormat: TextEdit.RichText
        wrapMode: TextEdit.NoWrap
        font.family: "sans-serif"
        font.pixelSize: tc.size
        text: "<pre>" + tc.body + "</pre>"
    }

    Text {
        id: sans
        y: 1300
        font.family: "sans-serif"
        font.pixelSize: tc.size
        text: tc.body
    }

    function test_gutterLinesMatchCodeLines(): void {
        compare(code.lineCount, 4);
        compare(gutter.lineCount, 4);
        compare(gutter.contentHeight, code.contentHeight);

        // Line n starts exactly n line-heights down, so a gutter offset by
        // -contentY lands on the right rows at every scroll position.
        const step = code.contentHeight / code.lineCount;
        const plain = code.getText(0, code.length);
        let at = 0;
        for (let n = 0; n < 4; n++) {
            fuzzyCompare(code.positionToRectangle(at).y, n * step, 0.5);
            // Rich text separates blocks with U+2029, not a newline.
            at += plain.split(/[\u2029\u2028\n]/u)[n].length + 1;
        }
    }

    function test_preservesWhitespaceAndOffersItForCopy(): void {
        // Indentation must survive as real spaces, not &nbsp;, or copying code
        // out of the pane pastes characters no compiler wants.
        code.selectAll();
        const selected = code.selectedText;
        const indent = selected.indexOf("    return");
        verify(indent >= 0);
        // 32, not 160: a non-breaking space would still have matched above.
        compare(selected.charCodeAt(indent), 32);
        compare(selected.charCodeAt(indent + 3), 32);
        code.deselect();
    }

    function test_longLinesDoNotWrap(): void {
        // The third line is wider than the view; the pane scrolls sideways
        // instead of folding it under the wrong gutter number.
        verify(code.contentWidth > code.width);
        compare(code.lineCount, 4);
    }

    function test_preIgnoresTheViewFontUnlessGivenOne(): void {
        // Pinning the reason CodeView writes font-family into the markup: a
        // bare <pre> stays fixed-pitch even when the view asks for sans.
        verify(Math.abs(bare.contentWidth - sans.contentWidth) > 1);
        fuzzyCompare(code.contentWidth, gutterWidthProbe.contentWidth, 0.5);
    }

    Text {
        id: gutterWidthProbe
        y: 1600
        font.family: tc.family
        font.pixelSize: tc.size
        text: tc.body
    }
}
