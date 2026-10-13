import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

TestCase {
    name: "FilePane"
    when: windowShown
    Component { id: factory; FilePane { filePath: "/tmp/ghost-test.md" } }
    property var pane: null
    property var editor: null
    property var file: null

    function init(): void {
        Workbench.prepareToLeave = null;
        Workbench.filePath = "/tmp/ghost-test.md";
        pane = createTemporaryObject(factory, this);
        verify(pane !== null);
        editor = findChild(pane, "markdownEditor");
        file = findChild(pane, "fileView");
        pane.readable = true;
        pane.diskText = "original\n";
        editor.adopt("my edits\n");
    }
    function cleanup(): void { pane.destroy(); Workbench.prepareToLeave = null; }

    function test_emptyExternalFileIsAConflict(): void {
        pane.absorb("");
        compare(pane.conflictText, "");
        verify(!pane.flush());
        compare(editor.buffer, "my edits\n");
        compare(file.writtenText, "");
        pane.takeTheirs();
        compare(editor.buffer, "");
        verify(!pane.dirty);
    }
    function test_conflictBlocksCloseAndSwitch(): void {
        pane.absorb("external\n");
        Workbench.close();
        compare(Workbench.filePath, "/tmp/ghost-test.md");
        Workbench.open("/tmp/another.md");
        compare(Workbench.filePath, "/tmp/ghost-test.md");
        compare(editor.buffer, "my edits\n");
    }
    function test_failedSaveBlocksCloseAndSwitch(): void {
        file.failWrites = true;
        Workbench.close();
        compare(Workbench.filePath, "/tmp/ghost-test.md");
        verify(pane.dirty);
        Workbench.open("/tmp/another.md");
        compare(Workbench.filePath, "/tmp/ghost-test.md");
        file.failWrites = false;
        Workbench.close();
        compare(Workbench.filePath, "");
        compare(file.writtenText, "my edits\n");
    }
    function test_externalConflictRevertedToBaseResumesSaving(): void {
        pane.absorb("external\n");
        pane.absorb("original\n");
        compare(pane.conflictText, null);
        verify(pane.flush());
        compare(file.writtenText, "my edits\n");
    }
    function test_successfulUnchangedReloadClearsReadError(): void {
        editor.adopt("original\n");
        file.loadFailed();
        verify(pane.notice !== "");
        file.contents = "original\n";
        file.loaded();
        compare(pane.notice, "");
        verify(pane.readable);
    }
    function test_recoveredUnchangedFileResumesExpiredAutosave(): void {
        file.loadFailed();
        editor.edited();
        wait(900);
        verify(pane.dirty);
        compare(file.writtenText, "");
        file.contents = "original\n";
        file.loaded();
        tryCompare(file, "writtenText", "my edits\n", 1500);
        verify(!pane.dirty);
    }
    function test_unreadableDiskPreservesMergeBaseAndTyping(): void {
        file.loadFailed();
        compare(pane.diskText, "original\n");
        verify(!pane.flush());
        compare(editor.buffer, "my edits\n");
    }
}
