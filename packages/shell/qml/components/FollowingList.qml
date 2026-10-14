import QtQuick
import "../services"

// A ListView that follows its end, but only while the reader is already at the
// bottom — yanking the view back down while they read earlier text is worse
// than falling behind. Scrolling reads like pi's fullscreen transcript: a
// scrollbar that shows only while the view moves or the pointer is on it, a
// "Jump to latest message" label while scrolled up, and keys (`handleKey`)
// that page, jump to either end, and step between marked rows.
ListView {
    id: root

    property bool pinned: true

    /** Whether row `index` is a stop for Ctrl+Shift+Up/Down (pi's prompts). */
    property var isMarked: index => false

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

    readonly property bool scrollable: contentHeight > height + 1

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

    /** Back to the end, following new output again. */
    function toEnd(): void {
        pinned = true;
        judgedY = contentY;
        follow();
    }

    function toTop(): void {
        positionViewAtBeginning();
        judge();
    }

    /** Moves by `pages` viewport heights, kept inside the content. */
    function scrollBy(pages: real): void {
        const top = originY;
        const bottom = Math.max(top, originY + contentHeight - height);
        contentY = Math.max(top, Math.min(bottom, contentY + pages * height));
        if (pages > 0 && contentY >= bottom) toEnd();
    }

    // The row at the viewport's top edge.
    function topIndex(): int {
        for (let probe = 1; probe < height; probe += 8) {
            const index = indexAt(width / 2, contentY + probe);
            if (index >= 0) return index;
        }
        return -1;
    }

    /** Puts the previous (-1) or next (+1) marked row at the top. */
    function stepMarked(direction: int): void {
        const top = topIndex();
        if (top < 0) return;
        // A marked row cut off above the viewport is still "this" one: going
        // back first shows its start.
        const head = itemAtIndex(top);
        let index = direction < 0 && isMarked(top) && head !== null && head.y < contentY - 2
            ? top : top + direction;
        while (index >= 0 && index < count && !isMarked(index)) index += direction;
        if (index < 0 || index >= count) {
            if (direction > 0) toEnd();
            return;
        }
        positionViewAtIndex(index, ListView.Beginning);
        judge();
    }

    /** The transcript keys, taking precedence over the composer's. */
    function handleKey(event: var): bool {
        const ctrl = event.modifiers & Qt.ControlModifier;
        const shift = event.modifiers & Qt.ShiftModifier;
        if (event.key === Qt.Key_PageUp) scrollBy(-0.9);
        else if (event.key === Qt.Key_PageDown) scrollBy(0.9);
        else if (ctrl && event.key === Qt.Key_Home) toTop();
        else if (ctrl && event.key === Qt.Key_End) toEnd();
        else if (ctrl && shift && event.key === Qt.Key_Up) stepMarked(-1);
        else if (ctrl && shift && event.key === Qt.Key_Down) stepMarked(1);
        else return false;
        reveal.restart();
        return true;
    }

    boundsBehavior: Flickable.StopAtBounds
    onContentYChanged: {
        if (!following) judge();
        if (!following && scrollable) reveal.restart();
    }
    onCountChanged: follow()
    onContentHeightChanged: follow()

    // Shown while the view moves and a moment after, or while the pointer is
    // on the bar itself.
    Timer {
        id: reveal
        interval: 900
    }

    // A ListView puts declared children in its scrolling contentItem; these
    // two are moved onto the view so they stay put while the rows scroll.
    Item {
        id: scrollbar
        objectName: "scrollbar"

        Component.onCompleted: parent = root
        anchors.top: parent.top
        anchors.bottom: parent.bottom
        anchors.right: parent.right
        width: 12
        z: 10
        visible: root.scrollable
        readonly property bool shown: reveal.running || barHover.hovered || drag.pressed
        opacity: shown ? 1 : 0

        Behavior on opacity {
            enabled: !Theme.reducedMotion
            NumberAnimation { duration: Theme.durFast }
        }

        HoverHandler { id: barHover }

        Rectangle {
            id: thumb
            readonly property bool wide: barHover.hovered || drag.pressed
            anchors.right: parent.right
            anchors.rightMargin: 2
            width: wide ? 8 : 4
            radius: width / 2
            y: Math.max(0, Math.min(parent.height - height,
                root.visibleArea.yPosition * parent.height))
            height: Math.max(24, root.visibleArea.heightRatio * parent.height)
            color: Theme.film(wide ? 0.45 : 0.28)
        }

        // Dragging moves the thumb; a click on the track jumps it there.
        MouseArea {
            id: drag
            anchors.fill: parent
            enabled: scrollbar.shown
            property real grab: 0
            function moveTo(thumbTop: real): void {
                const span = Math.max(1, scrollbar.height - thumb.height);
                const fraction = Math.max(0, Math.min(1, thumbTop / span));
                root.contentY = root.originY + fraction * (root.contentHeight - root.height);
                if (fraction >= 1) root.toEnd();
                reveal.restart();
            }
            onPressed: mouse => {
                grab = mouse.y >= thumb.y && mouse.y <= thumb.y + thumb.height
                    ? mouse.y - thumb.y : thumb.height / 2;
                moveTo(mouse.y - grab);
            }
            onPositionChanged: mouse => { if (pressed) moveTo(mouse.y - grab); }
        }
    }

    Rectangle {
        id: jump
        objectName: "jumpToLatest"

        Component.onCompleted: parent = root
        anchors.horizontalCenter: parent.horizontalCenter
        anchors.bottom: parent.bottom
        anchors.bottomMargin: Theme.gap
        z: 10
        visible: !root.pinned && root.scrollable
        width: label.implicitWidth + Theme.pad * 2
        height: label.implicitHeight + Theme.gap
        radius: height / 2
        color: jumpArea.containsMouse ? Theme.surface : Theme.background
        border.width: 1
        border.color: jumpArea.containsMouse ? Theme.film(0.30) : Theme.film(0.15)

        Accessible.role: Accessible.Button
        Accessible.name: "Jump to latest message"

        Text {
            id: label
            anchors.centerIn: parent
            text: "↓ Jump to latest message  <font color='" + Theme.foregroundFaint + "'>Ctrl+End</font>"
            textFormat: Text.StyledText
            color: jumpArea.containsMouse ? Theme.foregroundBright : Theme.foreground
            font.family: Theme.fontFamily
            font.pixelSize: Theme.fontSizeSmall
        }

        MouseArea {
            id: jumpArea
            anchors.fill: parent
            hoverEnabled: true
            cursorShape: Qt.PointingHandCursor
            onClicked: root.toEnd()
        }
    }
}
