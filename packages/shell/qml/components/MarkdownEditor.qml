pragma ComponentBehavior: Bound

// A Markdown source file, edited without lossy rich-text round trips.
//
// This began as `TextEdit { textFormat: TextEdit.MarkdownText }` — Qt 6 does
// parse CommonMark into an editable document and can serialise it back through
// `text`, which would have given WYSIWYG editing for free. A probe against Qt
// 6.11.2 (pinned in test/tst_markdownroundtrip.qml) found the return trip
// destroys the file:
//
//   - A raw HTML block is *silently eaten*: "text\n\n<div>x</div>\n\ntext"
//     comes back as "textx\n\ntext".
//   - A lone thematic break ("---\n") comes back as "".
//   - Hard line breaks (two trailing spaces) become paragraph breaks.
//   - Table alignment markers ("|:---|---:|") are dropped.
//   - Backslash escapes are consumed ("\*" -> "*"), and markdown *typed* into
//     the widget is escaped instead of parsed, so "# Hi" is written out as
//     "\# Hi" — a person typing markdown corrupts their own document.
//   - Worst: YAML front matter is stored on the QTextDocument out of band and
//     is never cleared. Load one document with front matter and every subsequent
//     document set on that same TextEdit is serialised with the *first* document's
//     front matter prepended. `clear()` and `text = ""` do not reset it.
//   - There is no way to apply formatting anyway: Ctrl+B / Ctrl+I are not
//     bound, and a toolbar is not the Notes-quiet brief.
//
// So editing is the markdown *source*, in monospace, which is lossless by
// construction — the bytes we save are the bytes the user typed. Rendering is
// the safe half of Qt's markdown support (a read-only Text never serialises),
// so the pane keeps a reading view of the live buffer alongside; the header
// word names which one is showing. Do not reintroduce editable MarkdownText
// without re-running that probe.
//
// Plain TextEdit rather than QtQuick.Controls TextArea, as everywhere else in
// this shell: Controls would drag in a style whose colours compete with the
// shared design tokens.
import QtQuick
import "../services"

Item {
    id: root

    /** The file's text as last seen on disk. The owner drives this; it is
        never bound straight to the editor, because that would let a write from
        the ghost overwrite whatever the user is halfway through typing. */
    required property string source

    /** Rendered markdown instead of the source. Read-only either way in the
        sense that matters: the preview never writes back. */
    property bool reading: false

    readonly property alias buffer: field.text
    readonly property bool dirty: field.text !== root.source

    signal edited()

    property bool adopting: false
    function adopt(text: string): void {
        root.adopting = true;
        field.text = text;
        root.adopting = false;
    }

    /** Take text that already contains the user's own edits — the result of a
        three-way merge — without counting as an edit and without throwing the
        caret to the top of the document. */
    function adoptMerged(text: string): void {
        const caret = field.cursorPosition;
        const before = field.text;
        root.adopt(text);
        // The heuristic, and it is only a heuristic: an offset means the same
        // thing in both texts exactly as far as the two agree, so a caret
        // inside the common prefix is still pointing at the character it was
        // pointing at. Past that point there is no honest mapping without a
        // character-level diff of a line-level merge, so the caret clamps into
        // the new text and lands near where it was rather than nowhere.
        let common = 0;
        const limit = Math.min(before.length, text.length);
        while (common < limit
            && before.charCodeAt(common) === text.charCodeAt(common)) common++;
        field.cursorPosition = caret <= common
            ? caret : Math.min(caret, text.length);
    }

    function take(): void {
        field.forceActiveFocus();
    }

    Component.onCompleted: root.adopt(root.source)

    implicitWidth: 420
    implicitHeight: 240

    // The reading column, measured rather than guessed: ~72 monospace columns
    // of source, ~68 of proportional prose. Wider than that and the eye loses
    // the line start on the way back.
    TextMetrics {
        id: column
        font.family: root.reading ? Theme.fontFamily : Theme.fontFamilyMono
        font.pixelSize: Theme.fontSize
        text: "0".repeat(root.reading ? 68 : 72)
    }

    // Paper: one step off the chat canvas in both themes, so an open document reads
    // as a sheet laid on the surface rather than as more transcript.
    Rectangle {
        anchors.fill: parent
        color: Theme.surface
    }

    Flickable {
        id: flick

        anchors.fill: parent
        clip: true
        contentWidth: width
        contentHeight: (root.reading ? preview.implicitHeight : field.implicitHeight)
            + Theme.pad * 2
        boundsBehavior: Flickable.StopAtBounds
        interactive: contentHeight > height

        // Typing at the bottom of a long document must not scroll the caret away.
        // Flickable does not follow a TextEdit cursor on its own.
        function ensureVisible(caret: rect): void {
            const top = field.y + caret.y - Theme.gap;
            const bottom = field.y + caret.y + caret.height + Theme.gap;
            if (flick.contentY > top) flick.contentY = Math.max(0, top);
            else if (flick.contentY + flick.height < bottom)
                flick.contentY = bottom - flick.height;
        }

        TextEdit {
            id: field

            x: Math.max(Theme.pad, (flick.width - width) / 2)
            y: Theme.pad
            width: Math.min(flick.width - Theme.pad * 2, Math.ceil(column.width))
            visible: !root.reading
            enabled: !root.reading
            color: Theme.foreground
            font.family: Theme.fontFamilyMono
            font.pixelSize: Theme.fontSize
            // No lineHeight here: QQuickTextEdit does not have one (it is a
            // QQuickText property), so the source view takes the font's own
            // leading. Theme.lineHeight reaches the reading view below.
            wrapMode: TextEdit.Wrap
            selectByMouse: true
            selectionColor: Theme.selection
            selectedTextColor: Theme.foregroundBright
            persistentSelection: true

            onTextChanged: if (!root.adopting) root.edited()
            onCursorRectangleChanged: flick.ensureVisible(field.cursorRectangle)
        }

        // The safe direction of Qt's markdown support: parse and render, never
        // serialise. Heading sizes, code-span font and link underlines are
        // Qt's to decide — the same constraint Bubble.qml documents.
        Text {
            id: preview

            x: Math.max(Theme.pad, (flick.width - width) / 2)
            y: Theme.pad
            width: Math.min(flick.width - Theme.pad * 2, Math.ceil(column.width))
            visible: root.reading
            text: field.text
            textFormat: Text.MarkdownText
            color: Theme.foreground
            linkColor: Theme.ghostAmber
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSize
            lineHeight: Theme.lineHeight
            wrapMode: Text.Wrap
            onLinkActivated: link => ExternalLinks.openModelUrl(link)

            MouseArea {
                anchors.fill: parent
                acceptedButtons: Qt.NoButton
                cursorShape: preview.hoveredLink !== ""
                    ? Qt.PointingHandCursor : Qt.ArrowCursor
            }
        }
    }

    // An empty document says so rather than showing a bare cursor in a white field.
    Text {
        anchors.centerIn: parent
        visible: field.text === ""
        text: "Empty document"
        color: Theme.foregroundFaint
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
    }
}
