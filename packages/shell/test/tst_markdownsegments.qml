import QtQuick
import QtTest
import "../qml/components/MarkdownSegments.js" as MarkdownSegments

// The scanner behind a streaming reply's rendering. Two properties matter and
// nothing else does: what it closes is final and never revisited, and the
// pieces it hands back are cuts of the body rather than a rewrite of it.
TestCase {
    id: tc
    name: "MarkdownSegments"

    /**
     * Feed `body` in `chunkSize` steps, the way the flush tick feeds a growing
     * turn, and report what the scan produced and what it did along the way.
     */
    function stream(body: string, chunkSize: int): var {
        const cursor = MarkdownSegments.begin();
        const closed = [];
        let resets = 0;
        let tail = "";
        for (let end = chunkSize; ; end += chunkSize) {
            const grown = body.substring(0, Math.min(end, body.length));
            const step = MarkdownSegments.advance(grown, cursor);
            if (step.reset) resets += 1;
            for (const segment of step.segments) closed.push(segment);
            tail = step.tail;
            // The invariant the reader sees: whatever is on screen right now,
            // joined, is exactly the body that has arrived.
            compare(closed.join("") + tail, grown);
            if (end >= body.length) break;
        }
        return { segments: closed, tail: tail, resets: resets };
    }

    function test_streamClosesOnlyWhatCannotChange(): void {
        const body = "First paragraph of the answer.\n\n"
            + "Second paragraph, longer, still prose.\n\n"
            + "Third and last.\n";
        const run = tc.stream(body, 7);
        compare(run.resets, 0);
        compare(run.segments.length, 2);
        compare(run.segments[0], "First paragraph of the answer.\n\n");
        compare(run.segments[1], "Second paragraph, longer, still prose.\n\n");
        compare(run.tail, "Third and last.\n");
    }

    // The one that pays for the whole exercise: a segment closed early in a
    // long stream must be handed back once, unchanged, and never again.
    function test_settledSegmentsAreNeverReissued(): void {
        let body = "";
        for (let i = 0; i < 40; i++)
            body += "Paragraph number " + i + " of a long reply.\n\n";
        body += "The end.\n";

        const cursor = MarkdownSegments.begin();
        const closed = [];
        for (let end = 1; end <= body.length; end++) {
            const step = MarkdownSegments.advance(body.substring(0, end), cursor);
            for (const segment of step.segments) {
                // Nothing already closed may be issued a second time, and the
                // new one must start exactly where the last one stopped.
                verify(!step.reset);
                closed.push(segment);
            }
        }
        compare(closed.length, 40);
        compare(closed[0], "Paragraph number 0 of a long reply.\n\n");
        compare(closed[39], "Paragraph number 39 of a long reply.\n\n");
        compare(closed.join(""), body.substring(0, body.length - "The end.\n".length));
    }

    // Chunk boundaries are network boundaries; they must not reach the reader.
    function test_chunkSizeDoesNotChangeTheOutcome(): void {
        const body = "# Heading\n\nProse under it.\n\n"
            + "```js\nconst x = 1;\n\nconst y = 2;\n```\n\n"
            + "- one\n- two\n\nClosing line.\n";
        const whole = tc.stream(body, body.length);
        for (const size of [1, 3, 17, 64]) {
            const run = tc.stream(body, size);
            compare(run.segments.join("|"), whole.segments.join("|"));
            compare(run.tail, whole.tail);
        }
        compare(whole.segments.join("") + whole.tail, body);
    }

    // A blank line inside a fence is not a block boundary, and neither is one
    // inside a fence that a list item indents.
    function test_fencedCodeStaysWhole(): void {
        const run = tc.stream("Intro.\n\n```\nfirst\n\nsecond\n```\n\nAfter.\n", 5);
        compare(run.segments.length, 2);
        compare(run.segments[1], "```\nfirst\n\nsecond\n```\n\n");

        const nested = tc.stream("- item\n\n  ```\n  a\n\n  b\n  ```\n\nAfter.\n", 5);
        compare(nested.segments.length, 1);
        compare(nested.segments[0], "- item\n\n  ```\n  a\n\n  b\n  ```\n\n");
    }

    // A blank line between items makes one loose list. Splitting it would
    // render two, and would restart an ordered one at 1.
    function test_looseListIsOneBlock(): void {
        const run = tc.stream("1. first\n\n2. second\n\n3. third\n\nAfter.\n", 4);
        compare(run.segments.length, 1);
        compare(run.segments[0], "1. first\n\n2. second\n\n3. third\n\n");
        compare(run.tail, "After.\n");
    }

    // An indented paragraph after a blank line belongs to the item above it.
    function test_indentedContinuationStaysWithItsItem(): void {
        const run = tc.stream("- item\n\n    still the item\n\nAfter.\n", 6);
        compare(run.segments.length, 1);
        compare(run.segments[0], "- item\n\n    still the item\n\n");
    }

    // A reference definition is read from wherever it sits in the document, so
    // the link and the definition have to stay in one.
    function test_linkDefinitionsAreNotSplitApart(): void {
        const run = tc.stream("See [the docs][d].\n\n[d]: https://example.com\n\nAfter.\n", 9);
        compare(run.segments.length, 0);
        compare(run.tail, "See [the docs][d].\n\n[d]: https://example.com\n\nAfter.\n");
    }

    function test_headingsAndQuotesAndTablesSplitCleanly(): void {
        const run = tc.stream("# Title\n\nProse.\n\n> quoted\n\n| a | b |\n| - | - |\n\nEnd.\n", 11);
        compare(run.segments.length, 4);
        compare(run.segments[0], "# Title\n\n");
        compare(run.segments[2], "> quoted\n\n");
        compare(run.segments[3], "| a | b |\n| - | - |\n\n");
    }

    // The trailing line of a stream has no newline yet, so what it starts
    // cannot be classified and nothing may close on it.
    function test_partialLineStaysInTheTail(): void {
        const cursor = MarkdownSegments.begin();
        const step = MarkdownSegments.advance("Done.\n\n- part", cursor);
        compare(step.segments.length, 0);
        compare(step.tail, "Done.\n\n- part");
        const next = MarkdownSegments.advance("Done.\n\n- partial\n", cursor);
        compare(next.segments.length, 1);
        compare(next.segments[0], "Done.\n\n");
        compare(next.tail, "- partial\n");
    }

    // A transcript row reused for another message, or a turn re-split once it
    // settled, is not a continuation of anything on screen.
    function test_bodyThatDoesNotContinueResetsTheScan(): void {
        const cursor = MarkdownSegments.begin();
        const opening = MarkdownSegments.advance("Alpha.\n\nBeta.\n\nGamma.\n", cursor);
        verify(!opening.reset);
        compare(opening.segments.length, 2);

        const replaced = MarkdownSegments.advance("Something else entirely.", cursor);
        verify(replaced.reset);
        compare(replaced.segments.length, 0);
        compare(replaced.tail, "Something else entirely.");
    }

    // While the turn is open its last line may still grow, so the block before
    // it has to stay open too. Once the turn settles that line is finished, and
    // the answer closes down to its final block.
    function test_settlingClosesTheBlockTheLastLineWasHolding(): void {
        const run = tc.stream("Alpha.\n\nBeta.\n\nGamma.", 3);
        compare(run.segments.length, 1);
        compare(run.segments[0], "Alpha.\n\n");
        compare(run.tail, "Beta.\n\nGamma.");

        const cursor = MarkdownSegments.begin();
        MarkdownSegments.advance("Alpha.\n\nBeta.\n\nGamma.", cursor, false);
        const settled = MarkdownSegments.advance("Alpha.\n\nBeta.\n\nGamma.", cursor, true);
        verify(!settled.reset);
        compare(settled.segments.length, 1);
        compare(settled.segments[0], "Beta.\n\n");
        compare(settled.tail, "Gamma.");
    }

    function test_emptyBodyIsEmpty(): void {
        const cursor = MarkdownSegments.begin();
        const step = MarkdownSegments.advance("", cursor);
        compare(step.segments.length, 0);
        compare(step.tail, "");
    }
}
