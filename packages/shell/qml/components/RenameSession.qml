// RenameSession — the list-held half of an inline rename.
//
// Held beside the list rather than on the row, and it has to be: rosters and
// listings are replaced wholesale on every refresh, which rebuilds every
// delegate underneath a half-typed name. The row's InlineRename field reports
// what happens; this object keeps the draft and the latch that survive the
// rebuild, and decides what a commit, a cancel, and a lost keyboard mean.
import QtQuick

QtObject {
    id: root

    /** Applies the rename: called as commit(key, draft), only ever with a
        non-empty trimmed draft. */
    required property var commit

    /** A rename ended, one way or the other. Nothing about the view changed —
        the keyboard just has nowhere to be. */
    signal finished()

    /** The key of the row being renamed, or "" while idle. */
    property string editingKey: ""
    property string draft: ""
    /** The field currently up, or null. A reference rather than a flag:
        a rebuilt row can take the keyboard before the row it replaced
        reports losing it, and only the object itself knows the truth. */
    property var editor: null

    function begin(key: string, seed: string): void {
        root.draft = seed;
        root.editingKey = key;
    }

    function commitRename(): void {
        const key = root.editingKey;
        if (key === "") return;
        const value = root.draft.trim();
        // An emptied field is not a request to have no name — nothing here can
        // be un-named — so it means the same as Esc: keep what was there.
        if (value === "") {
            root.cancel();
            return;
        }
        root.editingKey = "";
        root.draft = "";
        root.commit(key, value);
        root.finished();
    }

    function cancel(): void {
        if (root.editingKey === "") return;
        root.editingKey = "";
        root.draft = "";
        root.finished();
    }

    /**
     * Losing the keyboard commits — but a re-list destroys the field and
     * builds a new one, and that is not the owner clicking away. So the field
     * asks a tick later (Qt.callLater at the onFocusLost site): if nothing has
     * taken the keyboard back by then, they really did leave.
     */
    function commitOnBlur(): void {
        if (root.editingKey === "" || (root.editor && root.editor.activeFocus)) return;
        root.commitRename();
    }
}
