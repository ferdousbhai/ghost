import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    id: tc
    name: "MemoryList"

    Component {
        id: listComponent
        MemoryList {
            width: 700
            height: 400
        }
    }

    // As the daemon lists them: newest first.
    readonly property var facts: [
        { path: "memory/newer.md", slug: "newer", content: "A newer fact.",
          updated: "2026-08-27T10:00:00.000Z" },
        { path: "memory/older.md", slug: "older", content: "An older fact.",
          updated: "2026-08-20T10:00:00.000Z" }
    ]

    function init(): void {
        Ghostd.activeGhost = "casper";
        Ghostd.memoryGhost = "casper";
        Ghostd.memoryLoading = false;
        Ghostd.memoryError = "";
        Ghostd.memoryBusyPath = "";
        Ghostd.memory = tc.facts;
    }

    function cleanup(): void {
        Ghostd.memory = [];
        Ghostd.memoryBusyPath = "";
        Ghostd.memoryGhost = "";
        Ghostd.activeGhost = "";
    }

    function test_rowsAreTheMemoriesAsListed(): void {
        const list = createTemporaryObject(listComponent, tc);
        verify(list !== null);
        compare(list.rows.length, 2);
        compare(list.rows[0].slug, "newer");
        compare(list.rows[1].content, "An older fact.");
    }

    function test_draftIsAnEmptyRowOnTopAndVanishesWhenLeftEmpty(): void {
        const list = createTemporaryObject(listComponent, tc);
        list.beginDraft();
        verify(list.editing);
        compare(list.rows.length, 3);
        compare(list.rows[0].path, "memory/");
        compare(list.rows[0].content, "");

        list.commitEdit();
        verify(!list.editing);
        compare(list.rows.length, 2);
        compare(Ghostd.memoryBusyPath, "");
    }

    function test_listFreezesWhileEditingAndFollowsDiskAfter(): void {
        const list = createTemporaryObject(listComponent, tc);
        list.beginEdit(tc.facts[0]);
        Ghostd.memory = [{
            path: "memory/landed.md", slug: "landed", content: "Landed mid-edit.",
            updated: "2026-08-28T10:00:00.000Z"
        }].concat(tc.facts);
        compare(list.rows.length, 2);

        list.editText = "A newer fact.";
        list.commitEdit();
        compare(Ghostd.memoryBusyPath, "");
        compare(list.rows.length, 3);
        compare(list.rows[0].slug, "landed");
    }

    function test_changedTextIsWrittenBackToTheSameFile(): void {
        const list = createTemporaryObject(listComponent, tc);
        list.beginEdit(tc.facts[1]);
        list.editText = "  An older fact, corrected.\n";
        list.commitEdit();
        verify(!list.editing);
        compare(Ghostd.memoryBusyPath, "memory/older.md");
        compare(list.lastAttempt.text, "  An older fact, corrected.\n");
        // A saved draft has no file until the daemon names it.
        Ghostd.memoryBusyPath = "";
        list.beginDraft();
        list.editText = "Brand new.";
        list.commitEdit();
        compare(Ghostd.memoryBusyPath, "memory/");
    }

    function test_escapeDiscardsAndNothingStartsWhileBusy(): void {
        const list = createTemporaryObject(listComponent, tc);
        list.beginEdit(tc.facts[1]);
        list.editText = "Typed then abandoned.";
        list.endEdit();
        verify(!list.editing);
        compare(Ghostd.memoryBusyPath, "");

        Ghostd.memoryBusyPath = "memory/older.md";
        list.beginDraft();
        verify(!list.editing);
        list.remove("memory/newer.md");
        compare(Ghostd.memoryBusyPath, "memory/older.md");
    }

    function test_refusedWriteHandsTheTextBack(): void {
        const list = createTemporaryObject(listComponent, tc);
        list.beginEdit(tc.facts[1]);
        list.editText = "An older fact, corrected.";
        list.commitEdit();
        Ghostd.memoryBusyPath = "";
        Ghostd.memoryWriteFinished("memory/older.md", false);
        verify(list.editing);
        compare(list.editingPath, "memory/older.md");
        compare(list.editText, "An older fact, corrected.");
        list.endEdit();
    }
}
