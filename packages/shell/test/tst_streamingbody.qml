import QtQuick
import QtTest
import qs.components
import qs.services

// A long reply arriving a few characters at a time. The transcript used to hand
// Qt the whole accumulated body on every flush tick, which parses the whole
// answer every tick; it now hands over one block at a time. Two things have to
// hold for that to be a rendering change and not a behaviour change: a block
// already on screen is never rebuilt, and the finished reply reads exactly as
// the single document it replaced.
TestCase {
    id: tc
    name: "StreamingBody"
    when: windowShown
    width: 700
    height: 500
    visible: true

    readonly property string answer:
        "# What I found\n\n"
        + "The invoice is in the shared folder, filed under the old client "
        + "name rather than the new one, which is why the search missed it.\n\n"
        + "Three things stood out while I was in there:\n\n"
        + "- the folder still carries last year's permissions\n"
        + "- two of the PDFs are scans, not text\n"
        + "- the naming scheme changed in March\n\n"
        + "## The renaming script\n\n"
        + "```sh\nfor f in *.pdf; do\n\n  mv \"$f\" \"${f/old/new}\"\ndone\n```\n\n"
        + "> It renames in place, so take a copy first.\n\n"
        + "| file | state |\n| --- | --- |\n| march.pdf | scanned |\n\n"
        + "Say the word and I will run it.";

    // The same answer in prose alone. Qt gives code, tables and rules margins
    // of their own that a document of one block has no neighbour to collapse
    // against (see Theme.markdownBlockGap), so only prose can be held to the
    // pixel — and prose is what a reply is mostly made of.
    readonly property string prose:
        "# What I found\n\n"
        + "The invoice is in the shared folder, filed under the old client "
        + "name rather than the new one, which is why the search missed it.\n\n"
        + "Three things stood out while I was in there:\n\n"
        + "- the folder still carries last year's permissions\n"
        + "- two of the PDFs are scans, not text\n"
        + "- the naming scheme changed in March\n\n"
        + "## What I would do next\n\n"
        + "Rename them in place, from a copy of the folder.\n\n"
        + "Say the word and I will run it.";

    property string streamed: ""
    property string prompt: ""
    property bool settled: false

    Bubble {
        id: reply

        width: 600
        speaker: "assistant"
        body: tc.streamed
        toolTrail: ""
        activities: []
        failure: ""
        busy: !tc.settled
        sourceEntryId: ""
        rowIndex: 0
    }

    Bubble {
        id: asked

        width: 600
        speaker: "user"
        body: tc.prompt
        toolTrail: ""
        activities: []
        failure: ""
        busy: true
        sourceEntryId: ""
        rowIndex: 0
    }

    // The same answer as one document — what the reply used to be.
    Text {
        id: whole

        width: 600
        textFormat: Text.MarkdownText
        wrapMode: Text.Wrap
        font.family: Theme.fontFamily
        font.pixelSize: Theme.fontSize
        lineHeight: Theme.lineHeight
        text: tc.prose
    }

    /** The settled blocks of a bubble, in the order the scene holds them. */
    function blocksOf(bubble: var): var {
        const blocks = [];
        function collect(item) {
            if (item.objectName === "replyBlock") blocks.push(item);
            for (let i = 0; i < item.children.length; i += 1) collect(item.children[i]);
        }
        collect(bubble);
        return blocks;
    }

    /** The block still being written. */
    function tailOf(bubble: var): var {
        return findChild(bubble, "replyTail");
    }

    /** The column the blocks are stacked in. */
    function bodyOf(bubble: var): var {
        return tc.tailOf(bubble).parent;
    }

    function cleanup(): void {
        tc.streamed = "";
        tc.prompt = "";
        tc.settled = false;
        wait(0);
    }

    // The point of the exercise: what is on screen and settled is never touched
    // again, however much more of the answer arrives.
    function test_settledBlocksAreNeverRebuilt(): void {
        let seen = [];
        for (let end = 1; end <= tc.answer.length; end += 7) {
            tc.streamed = tc.answer.substring(0, Math.min(end, tc.answer.length));
            wait(0);
            const blocks = tc.blocksOf(reply);
            verify(blocks.length >= seen.length);
            for (let i = 0; i < seen.length; i++) {
                // Same object, same text: not re-created, not re-parsed.
                compare(blocks[i], seen[i].item);
                compare(blocks[i].text, seen[i].text);
            }
            const rendered = [];
            for (const block of blocks) rendered.push(block.text);
            compare(rendered.join("") + tc.tailOf(reply).text, tc.streamed);
            seen = blocks.map(function (block) {
                return { item: block, text: block.text };
            });
        }
        verify(seen.length >= 6);
    }

    // Every block kind a reply uses has to come out of the far end intact,
    // headings and fenced code and tables included.
    function test_finishedReplyIsTheAnswerCharacterForCharacter(): void {
        tc.streamed = tc.answer;
        wait(0);
        const rendered = [];
        for (const block of tc.blocksOf(reply)) rendered.push(block.text);
        compare(rendered.join("") + tc.tailOf(reply).text, tc.answer);
    }

    // And it has to take the same room: documents stacked with the gap markdown
    // leaves between two blocks are the one document they replaced.
    function test_proseRendersAsOneDocumentWould(): void {
        tc.streamed = tc.prose;
        tc.settled = true;
        wait(0);
        waitForRendering(reply);
        fuzzyCompare(tc.bodyOf(reply).implicitHeight, whole.implicitHeight, 1);
    }

    // Chunk boundaries are network boundaries; the reader must not be able to
    // tell how the answer arrived.
    function test_arrivalOrderDoesNotChangeTheResult(): void {
        tc.streamed = tc.answer;
        wait(0);
        const atOnce = [];
        for (const block of tc.blocksOf(reply)) atOnce.push(block.text);

        tc.streamed = "";
        wait(0);
        for (let end = 3; end < tc.answer.length; end += 31) {
            tc.streamed = tc.answer.substring(0, end);
            wait(0);
        }
        tc.streamed = tc.answer;
        wait(0);
        const streamed = [];
        for (const block of tc.blocksOf(reply)) streamed.push(block.text);
        compare(streamed.join("|"), atOnce.join("|"));
    }

    // A prompt is one verbatim block: splitting it would render its backticks
    // and underscores as markup.
    function test_promptStaysOneVerbatimBlock(): void {
        tc.prompt = "why does `ls -_-` print\n\nthat, and *not* this?";
        wait(0);
        compare(tc.blocksOf(asked).length, 0);
        const tail = tc.tailOf(asked);
        compare(tail.text, tc.prompt);
        compare(tail.textFormat, Text.PlainText);
    }

    // The list reuses a row's delegate for another message, and a turn re-splits
    // its own body once it settles. Neither continues what is on screen.
    function test_rowReusedForAnotherMessageStartsOver(): void {
        tc.streamed = tc.answer;
        wait(0);
        verify(tc.blocksOf(reply).length > 0);

        tc.streamed = "Something else entirely.\n\nOn a different subject.";
        wait(0);
        const rendered = [];
        for (const block of tc.blocksOf(reply)) rendered.push(block.text);
        compare(rendered.join("") + tc.tailOf(reply).text, tc.streamed);
    }

    // An empty row shows nothing rather than an empty block.
    function test_emptyBodyShowsNothing(): void {
        tc.streamed = "";
        wait(0);
        compare(tc.blocksOf(reply).length, 0);
        verify(!tc.tailOf(reply).visible);
    }
}
