import QtQuick
import QtTest
import "../qml/components"

// Rows of unequal height move a ListView's originY far from 0 and make its
// end an estimate: the list must still land on its end and keep following.
TestCase {
    id: tc
    name: "FollowingList"
    when: windowShown
    width: 600
    height: 500
    visible: true

    ListModel { id: rows }

    Component {
        id: listComponent
        FollowingList {
            id: view
            width: 600
            height: 500
            model: rows
            cacheBuffer: 400
            spacing: 6
            isMarked: index => index % 50 === 0
            delegate: Text {
                required property string body
                width: view.width
                wrapMode: Text.Wrap
                text: body
            }
        }
    }

    function fill(list: var): void {
        for (let i = 0; i < 400; i++) {
            const words = (i * 7919) % 97 === 0 ? 400 : ((i * 31) % 13) * 40 + 5;
            rows.append({ body: "row " + i + " " + "lorem ipsum ".repeat(words) });
        }
        tryVerify(() => list.contentHeight > 0, 2000);
        wait(50);
    }

    function cleanup(): void {
        rows.clear();
    }

    function test_lands_on_the_end_of_a_long_transcript(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        verify(list.pinned);
    }

    function test_a_reader_back_at_the_end_is_followed_again(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        verify(list.originY < 0, "the rows must move originY for this test to mean anything");
        list.contentY -= 1;
        list.contentY += 1;
        verify(list.pinned, "at the end with originY " + list.originY);
        rows.append({ body: "a new reply" });
        tryVerify(() => list.atYEnd, 2000);
    }

    function test_a_reader_scrolled_up_stays_put(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        list.positionViewAtBeginning();
        wait(100);
        verify(!list.pinned);
        rows.append({ body: "a new reply" });
        wait(100);
        verify(!list.pinned);
        verify(!list.atYEnd);
    }

    // A scrollbar drag sets contentY directly; the jump re-estimates
    // contentHeight before contentYChanged arrives.
    function test_a_reader_dragged_to_the_top_stays_put(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        list.contentY = list.originY;
        wait(100);
        verify(!list.pinned);
        rows.append({ body: "a new reply" });
        wait(100);
        verify(!list.pinned);
        verify(!list.atYEnd);
    }

    function test_a_growing_last_row_is_followed(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        rows.append({ body: "a new reply" });
        for (let i = 0; i < 20; i++) {
            rows.setProperty(rows.count - 1, "body", rows.get(rows.count - 1).body + " more".repeat(30));
            wait(10);
        }
        tryVerify(() => list.atYEnd, 2000);
        verify(list.pinned);
    }

    function key(list: var, code: int, modifiers: int): bool {
        return list.handleKey({ key: code, modifiers: modifiers });
    }

    function test_jump_label_shows_while_scrolled_up_and_returns_to_the_end(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        const jump = findChild(list, "jumpToLatest");
        verify(jump !== null);
        verify(!jump.visible);
        verify(jump.parent === list, "the label must sit on the view, not scroll with the rows");
        list.positionViewAtBeginning();
        wait(50);
        verify(jump.visible);
        mouseClick(jump);
        tryVerify(() => list.atYEnd, 2000);
        verify(list.pinned);
        verify(!jump.visible);
        rows.append({ body: "a new reply" });
        tryVerify(() => list.atYEnd, 2000);
    }

    function test_scrollbar_shows_only_while_scrolling(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        const bar = findChild(list, "scrollbar");
        verify(bar !== null);
        tryVerify(() => !bar.shown, 2000);
        list.contentY -= 200;
        verify(bar.shown);
        tryVerify(() => !bar.shown, 2000);
    }

    function test_pressing_minimum_size_thumb_does_not_jump(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        list.positionViewAtIndex(200, ListView.Beginning);
        wait(100);
        const bar = findChild(list, "scrollbar");
        const thumb = findChild(list, "scrollbarThumb");
        verify(bar !== null && thumb !== null);
        compare(thumb.height, 24);
        const before = list.contentY;
        mousePress(bar, bar.width / 2, thumb.y + thumb.height / 2);
        verify(Math.abs(list.contentY - before) < 1, "pressing the thumb must not scroll");
        mouseRelease(bar, bar.width / 2, thumb.y + thumb.height / 2);
    }

    function test_keys_page_and_jump_to_either_end(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        const before = list.contentY;
        verify(key(list, Qt.Key_PageUp, 0));
        verify(list.contentY < before);
        verify(!list.pinned);
        verify(key(list, Qt.Key_PageDown, 0));
        verify(key(list, Qt.Key_PageDown, 0));
        tryVerify(() => list.atYEnd, 2000);
        verify(list.pinned);
        verify(key(list, Qt.Key_Home, Qt.ControlModifier));
        tryVerify(() => list.atYBeginning, 2000);
        verify(key(list, Qt.Key_End, Qt.ControlModifier));
        tryVerify(() => list.atYEnd, 2000);
        verify(list.pinned);
        verify(!key(list, Qt.Key_A, 0));
        verify(!key(list, Qt.Key_Home, 0));
    }

    function test_steps_between_marked_rows(): void {
        const list = createTemporaryObject(listComponent, tc);
        fill(list);
        tryVerify(() => list.atYEnd, 2000);
        list.positionViewAtIndex(120, ListView.Beginning);
        wait(50);
        verify(key(list, Qt.Key_Up, Qt.ControlModifier | Qt.ShiftModifier));
        wait(50);
        compare(list.topIndex(), 100);
        verify(key(list, Qt.Key_Up, Qt.ControlModifier | Qt.ShiftModifier));
        wait(50);
        compare(list.topIndex(), 50);
        verify(key(list, Qt.Key_Down, Qt.ControlModifier | Qt.ShiftModifier));
        wait(50);
        compare(list.topIndex(), 100);
    }
}
