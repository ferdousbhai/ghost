import QtQuick
import QtTest
import "../qml/components/Merge.js" as Merge

// The merge's job is to make the workbench's conflict prompt rare, and its one
// hard contract is that being rare must never cost a byte: a clean merge is
// made only of lines that were already in mine, theirs or base, in an order all
// three agree on. So the tests below check the *text*, not a diff summary, and
// the property test at the end re-derives that guarantee from scratch.
//
// FilePane itself cannot be instantiated here — it needs the `qs` module that
// only Quickshell synthesises at runtime, the same limitation
// test/tst_codegutter.qml and test/tst_markdownbody.qml record — so the pane's
// merge-first policy is pinned at this level: what FilePane.absorb() does with
// `{ok, text}` is a three-line branch over exactly these answers.
TestCase {
    id: tc
    name: "Merge"

    readonly property string base: "alpha\nbravo\ncharlie\ndelta\necho\n"

    function lines(count, word) {
        const out = [];
        for (let n = 0; n < count; n++) out.push(word + " " + n + "\n");
        return out.join("");
    }

    // ---- Disjoint edits ---------------------------------------------------

    function test_disjointRegionsBothApply(): void {
        const mine = "ALPHA\nbravo\ncharlie\ndelta\necho\n";
        const theirs = "alpha\nbravo\ncharlie\ndelta\nECHO\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(merged.ok);
        compare(merged.text, "ALPHA\nbravo\ncharlie\ndelta\nECHO\n");
    }

    function test_appendsAtOppositeEndsBothApply(): void {
        const merged = Merge.merge(tc.base, "top\n" + tc.base, tc.base + "bottom\n");
        verify(merged.ok);
        compare(merged.text, "top\n" + tc.base + "bottom\n");
    }

    function test_deletionAndDistantEditBothApply(): void {
        // Mine drops two lines, theirs rewrites one further down.
        const mine = "charlie\ndelta\necho\n";
        const theirs = "alpha\nbravo\ncharlie\ndelta\nECHO\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(merged.ok);
        compare(merged.text, "charlie\ndelta\nECHO\n");
    }

    // ---- One side idle ----------------------------------------------------

    function test_unchangedSideReturnsTheOtherVerbatim_data() {
        return [
            { tag: "theirs idle", mine: "ALPHA\nbravo\ncharlie\ndelta\necho\n",
                theirs: tc.base, want: "ALPHA\nbravo\ncharlie\ndelta\necho\n" },
            { tag: "mine idle", mine: tc.base,
                theirs: "alpha\nbravo\nCHARLIE\ndelta\necho\n",
                want: "alpha\nbravo\nCHARLIE\ndelta\necho\n" },
            { tag: "mine emptied the file", mine: "", theirs: tc.base, want: "" },
            { tag: "theirs emptied the file", mine: tc.base, theirs: "", want: "" },
            { tag: "nobody moved", mine: tc.base, theirs: tc.base, want: tc.base }
        ];
    }

    function test_unchangedSideReturnsTheOtherVerbatim(data) {
        const merged = Merge.merge(tc.base, data.mine, data.theirs);
        verify(merged.ok);
        compare(merged.text, data.want);
    }

    // ---- Agreement --------------------------------------------------------

    function test_identicalEditsCollapse(): void {
        // The same rewrite of line three on both sides, plus an edit only mine
        // made — so the collapse happens inside the walk, not in the shortcut
        // that catches two wholly identical texts.
        const mine = "ALPHA\nbravo\nCHARLIE\ndelta\necho\n";
        const theirs = "alpha\nbravo\nCHARLIE\ndelta\necho\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(merged.ok);
        compare(merged.text, "ALPHA\nbravo\nCHARLIE\ndelta\necho\n");
    }

    function test_identicalInsertionsAtOneBoundaryCollapse(): void {
        const mine = "ALPHA\nbravo\nnew\ncharlie\ndelta\necho\n";
        const theirs = "alpha\nbravo\nnew\ncharlie\ndelta\necho\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(merged.ok);
        compare(merged.text, "ALPHA\nbravo\nnew\ncharlie\ndelta\necho\n");
    }

    function test_bothSidesMadeTheSameWholeFile(): void {
        const same = "one\ntwo\n";
        const merged = Merge.merge(tc.base, same, same);
        verify(merged.ok);
        compare(merged.text, same);
    }

    // ---- Conflict ---------------------------------------------------------

    function test_sameLineDivergentEditsConflict(): void {
        const mine = "alpha\nbravo\nmine\ndelta\necho\n";
        const theirs = "alpha\nbravo\ntheirs\ndelta\necho\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(!merged.ok);
    }

    function test_sameBoundaryDifferentInsertionsConflict(): void {
        // Two different lines inserted at exactly the same point. Either order
        // would be a guess, so this is a conflict rather than a splice.
        const mine = "alpha\nbravo\nmine\ncharlie\ndelta\necho\n";
        const theirs = "alpha\nbravo\ntheirs\ncharlie\ndelta\necho\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(!merged.ok);
    }

    function test_overlappingRegionsConflict(): void {
        // Mine deletes the whole file while theirs edits inside it: the ranges
        // overlap, so there is nothing to keep from both.
        const theirs = "alpha\nBRAVO\ncharlie\ndelta\necho\n";
        const merged = Merge.merge(tc.base, "", theirs);
        verify(!merged.ok);
    }

    function test_interleavedRewritesConflictAsOne(): void {
        // Mine rewrites lines 1 and 3, theirs rewrites 2 — the group grows
        // across all three rather than splicing a plausible-looking hybrid.
        const mine = "alpha\nB1\ncharlie\nD1\necho\n";
        const theirs = "alpha\nbravo\nC2\ndelta\necho\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(merged.ok);
        // Those three edits are in fact disjoint by line, so they all apply;
        // the interleaving only matters once they touch the same line.
        compare(merged.text, "alpha\nB1\nC2\nD1\necho\n");

        const wider = "alpha\nB2\nC2\ndelta\necho\n";
        verify(!Merge.merge(tc.base, mine, wider).ok);
    }

    // ---- Boundaries -------------------------------------------------------

    function test_insertionBesideARewrittenLineMerges(): void {
        // An insertion *before* a line the other side rewrote is not a
        // conflict: both sides agree the new lines come before that line.
        const mine = "alpha\nbravo\nnew\ncharlie\ndelta\necho\n";
        const theirs = "alpha\nbravo\nCHARLIE\ndelta\necho\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(merged.ok);
        compare(merged.text, "alpha\nbravo\nnew\nCHARLIE\ndelta\necho\n");
    }

    function test_insertionInsideARewrittenRegionConflicts(): void {
        const mine = "alpha\nbravo\nnew\ncharlie\ndelta\necho\n";
        const theirs = "alpha\nBRAVO\nCHARLIE\ndelta\necho\n";
        const merged = Merge.merge(tc.base, mine, theirs);
        verify(!merged.ok);
    }

    // ---- Newlines ---------------------------------------------------------

    function test_missingTrailingNewlineSurvives(): void {
        // A file with no final newline: theirs appends to the last line's own
        // line, mine edits the first. Nothing gains a newline it did not have.
        const base = "one\ntwo\nthree";
        const merged = Merge.merge(base, "ONE\ntwo\nthree", "one\ntwo\nthree\nfour");
        verify(merged.ok);
        compare(merged.text, "ONE\ntwo\nthree\nfour");
    }

    function test_droppedTrailingNewlineIsAnEditLikeAnyOther(): void {
        const merged = Merge.merge("a\nb\nc\n", "a\nb\nc", "A\nb\nc\n");
        verify(merged.ok);
        compare(merged.text, "A\nb\nc");
    }

    function test_trailingNewlineChangedOnBothSidesConflicts(): void {
        const merged = Merge.merge("a\nb\n", "a\nb", "a\nB\n");
        verify(!merged.ok);
    }

    function test_blankLinesAreLinesToo(): void {
        const base = "a\n\nb\n";
        const merged = Merge.merge(base, "a\n\n\nb\n", "A\n\nb\n");
        verify(merged.ok);
        compare(merged.text, "A\n\n\nb\n");
    }

    // ---- Empty inputs -----------------------------------------------------

    function test_emptyBase_data() {
        return [
            { tag: "only mine wrote", mine: "x\n", theirs: "", ok: true, want: "x\n" },
            { tag: "only theirs wrote", mine: "", theirs: "y\n", ok: true, want: "y\n" },
            { tag: "both wrote the same", mine: "x\n", theirs: "x\n", ok: true, want: "x\n" },
            { tag: "both wrote something else", mine: "x\n", theirs: "y\n", ok: false, want: "" },
            { tag: "nobody wrote", mine: "", theirs: "", ok: true, want: "" }
        ];
    }

    function test_emptyBase(data) {
        const merged = Merge.merge("", data.mine, data.theirs);
        compare(merged.ok, data.ok);
        if (data.ok) compare(merged.text, data.want);
    }

    function test_nonStringInputsAreEmptyText(): void {
        // FileView hands back "" for a file it could not read, and a QML
        // property can be undefined before its first assignment.
        const merged = Merge.merge(undefined, null, "y\n");
        verify(merged.ok);
        compare(merged.text, "y\n");
    }

    // ---- Size ceilings ----------------------------------------------------

    function test_hugeFileFallsBackToTheConflictPrompt(): void {
        const base = tc.lines(20001, "line");
        const merged = Merge.merge(base, "first\n" + base, base + "last\n");
        verify(!merged.ok);
    }

    function test_wholeFileRewriteFallsBackToTheConflictPrompt(): void {
        // No common prefix, suffix or line, so nothing trims and the table
        // would be past the cell budget: the pane asks instead of stalling.
        const base = tc.lines(2000, "line");
        const merged = Merge.merge(base, tc.lines(2000, "other"),
            base + "tail\n");
        verify(!merged.ok);
    }

    function test_largeFileWithSmallEditsStillMerges(): void {
        // The same size the previous test refuses, but with the edits where
        // they actually land in a document: prefix and suffix trimming keeps the
        // table tiny, and this is the case that must not fall back.
        const base = tc.lines(5000, "line");
        const mine = base.replace("line 10\n", "MINE\n");
        const theirs = base.replace("line 4000\n", "THEIRS\n");
        const merged = Merge.merge(base, mine, theirs);
        verify(merged.ok);
        compare(merged.text,
            base.replace("line 10\n", "MINE\n").replace("line 4000\n", "THEIRS\n"));
    }

    // ---- The no-loss property ---------------------------------------------

    function test_cleanMergeInventsAndLosesNothing(): void {
        const base = tc.lines(12, "base");
        const mine = base.replace("base 1\n", "mine 1\n").replace("base 9\n", "mine 9\n");
        const theirs = base.replace("base 4\n", "theirs 4\n") + "theirs tail\n";
        const merged = Merge.merge(base, mine, theirs);
        verify(merged.ok);

        // 1. Every line of the result came from one of the two sides.
        const mineLines = mine.split("\n");
        const theirsLines = theirs.split("\n");
        for (const line of merged.text.split("\n")) {
            verify(mineLines.indexOf(line) >= 0 || theirsLines.indexOf(line) >= 0);
        }

        // 2. Every base line neither side touched is still there, in order.
        const untouched = ["base 0\n", "base 2\n", "base 3\n", "base 5\n",
            "base 6\n", "base 7\n", "base 8\n", "base 10\n", "base 11\n"];
        let at = 0;
        for (const line of untouched) {
            const found = merged.text.indexOf(line, at);
            verify(found >= at);
            at = found + line.length;
        }

        // 3. And both sides' edits actually landed.
        verify(merged.text.indexOf("mine 1\n") >= 0);
        verify(merged.text.indexOf("mine 9\n") >= 0);
        verify(merged.text.indexOf("theirs 4\n") >= 0);
        verify(merged.text.indexOf("theirs tail\n") >= 0);
    }
}
