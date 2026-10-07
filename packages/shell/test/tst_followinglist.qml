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
}
