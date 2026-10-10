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

    // The contentY that `pinned` was last judged at. A long jump (a scrollbar
    // drag, positionViewAtBeginning) builds rows at its target and re-estimates
    // contentHeight before contentYChanged is delivered, so a contentY that
    // differs from this belongs to a move `pinned` has not seen yet.
    property real judgedY: 0

    // Rows of unequal height move originY, so the end is measured from it.
    function judge(): void {
        judgedY = contentY;
        pinned = contentY >= originY + contentHeight - height - 40;
    }

    function follow(): void {
        if (following) return;
        if (contentY !== judgedY) judge();
        if (!pinned) return;
        following = true;
        positionViewAtEnd();
        judgedY = contentY;
        following = false;
    }

    onContentYChanged: if (!following) judge()
    onCountChanged: follow()
    onContentHeightChanged: follow()
}
