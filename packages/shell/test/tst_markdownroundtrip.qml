import QtQuick
import QtTest

// Why MarkdownEditor edits source instead of rendered markdown.
//
// `TextEdit { textFormat: TextEdit.MarkdownText }` is editable and round-trips
// back through `text`, which reads like WYSIWYG markdown for free. It is not:
// on Qt 6.11 the return trip loses data, and a document pane that quietly eats a
// paragraph is worse than one that shows you your own source.
//
// This test pins the *broken* behaviour deliberately. Every compare() below
// asserts what Qt does today, so the day Qt fixes any of it this file fails and
// somebody comes back to reconsider the design — which is the only way a
// decision made against a bug gets revisited. If one of these fails, re-run the
// design question; do not "fix" the expectation.
//
// Reformatting we would happily live with, recorded but not pinned: ordered
// list markers gain a second space ("1. a" -> "1.  a"), setext headings become
// ATX, tables are re-padded, and a trailing blank line is added to the file.
TestCase {
    id: tc
    name: "MarkdownRoundTrip"
    when: windowShown
    width: 320
    height: 200
    visible: true

    // Two editors: `ed` is reused the way one pane would reuse its TextEdit,
    // `fresh` is only ever handed one document.
    TextEdit {
        id: ed
        y: 400
        width: 300
        textFormat: TextEdit.MarkdownText
        font.pixelSize: 14
    }

    TextEdit {
        id: fresh
        y: 800
        width: 300
        textFormat: TextEdit.MarkdownText
        font.pixelSize: 14
    }

    function roundTrip(source) {
        ed.text = source;
        return ed.text;
    }


    function test_inlineAndBlockStructureSurvive(): void {
        compare(tc.roundTrip("# Heading\n"), "# Heading\n\n");
        compare(tc.roundTrip("**b** _i_ ~~s~~ `c`\n"), "**b** _i_ ~~s~~ `c`\n\n");
        compare(tc.roundTrip("- one\n- two\n"), "- one\n- two\n");
        compare(tc.roundTrip("- [ ] todo\n- [x] done\n"), "- [ ] todo\n- [x] done\n");
        compare(tc.roundTrip("> quote\n"), "> quote\n\n");
        compare(tc.roundTrip("```py\nx = 1\n```\n"), "```py\nx = 1\n```\n\n");
        compare(tc.roundTrip("[l](https://e.com)\n"), "[l](https://e.com)\n\n");
        compare(tc.roundTrip("Ünïcödé — “curly” 日本語\n"), "Ünïcödé — “curly” 日本語\n\n");
    }


    function test_rawHtmlBlockIsEaten(): void {
        // The <div> and the blank line before it are gone, and the text is
        // welded onto the preceding paragraph.
        compare(tc.roundTrip("text\n\n<div>raw</div>\n\nmore\n"), "textraw\n\nmore\n\n");
    }

    function test_thematicBreakDisappears(): void {
        compare(tc.roundTrip("---\n"), "");
    }

    function test_hardLineBreakBecomesAParagraph(): void {
        compare(tc.roundTrip("one  \ntwo\n"), "one\n\ntwo\n\n");
    }

    function test_tableAlignmentIsDropped(): void {
        compare(tc.roundTrip("| l | r |\n|:--|--:|\n| 1 | 2 |\n"),
            "\n|l|r|\n|-|-|\n|1|2|\n\n");
    }

    function test_backslashEscapesAreConsumed(): void {
        compare(tc.roundTrip("a \\* b\n"), "a * b\n\n");
    }

    function test_typedMarkdownIsEscapedNotParsed(): void {
        // Someone typing "# Hi" into their document gets "\# Hi" written to disk.
        ed.text = "";
        ed.forceActiveFocus();
        keyClick(Qt.Key_NumberSign);
        keyClick(Qt.Key_Space);
        keyClick(Qt.Key_H);
        compare(ed.text, "\\# h\n\n");
    }

    function test_boldShortcutDoesNothing(): void {
        // No Ctrl+B/Ctrl+I binding, so with no toolbar there is no way at all
        // to apply formatting to a selection.
        ed.text = "hello world\n";
        ed.forceActiveFocus();
        ed.select(0, 5);
        keyClick(Qt.Key_B, Qt.ControlModifier);
        compare(ed.text, "hello world\n\n");
        ed.deselect();
    }

    function test_frontMatterLeaksIntoTheNextDocument(): void {
        // The decisive one. Front matter is kept on the QTextDocument out of
        // band and is never cleared, so one document with front matter poisons
        // every later document shown in the same TextEdit — a pane that reuses
        // its editor would write document A's front matter into document B.
        compare(fresh.text, "");
        fresh.text = "---\ntitle: A\n---\n\nbody A\n";
        compare(fresh.text, "---\ntitle: A\n---\nbody A\n\n");
        fresh.text = "plain B\n";
        compare(fresh.text, "---\ntitle: A\n---\nplain B\n\n");
        fresh.clear();
        fresh.text = "plain C\n";
        compare(fresh.text, "---\ntitle: A\n---\nplain C\n\n");
    }


    function test_renderingIsSafe(): void {
        // A read-only Text never serialises, so the reading view can show
        // markdown that the editor would have mangled.
        preview.text = "---\ntitle: A\n---\n\n# Body\n\n<div>raw</div>\n";
        verify(preview.contentHeight > 0);
        preview.text = "plain\n";
        compare(preview.text, "plain\n");
    }

    Text {
        id: preview
        y: 1200
        width: 300
        textFormat: Text.MarkdownText
        wrapMode: Text.Wrap
        font.pixelSize: 14
    }
}
