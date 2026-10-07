import QtQuick

// A ListView that follows its end, but only while the reader is already at the
// bottom — yanking the view back down while they read earlier text is worse
// than falling behind.
ListView {
    id: root

    property bool pinned: true

    // Jumping to the end builds the rows there, which re-estimates contentHeight
    // while the jump is still running; following that change from inside the
    // jump fed a loop that pinned omarchy-shell at 100% CPU (2026-10-05). The
    // next change outside it follows.
    property bool following: false

    function follow(): void {
        if (!pinned || following) return;
        following = true;
        positionViewAtEnd();
        following = false;
    }

    // Rows of unequal height move originY, so the end is measured from it.
    onContentYChanged: if (!following) pinned = contentY >= originY + contentHeight - height - 40
    onCountChanged: follow()
    onContentHeightChanged: follow()
}
