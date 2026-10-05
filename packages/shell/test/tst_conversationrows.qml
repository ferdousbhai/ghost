import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

// The conversation list reconciles by id, so a re-list moves, inserts, and
// removes rows instead of resetting the model.
TestCase {
    id: tc
    name: "ConversationRows"
    when: windowShown
    width: 400
    height: 600
    visible: true

    Component {
        id: listComponent
        Conversations {
            width: 360
            height: 560
        }
    }

    function sessions(ids: var): var {
        return ids.map(id => ({ id: id, title: "t-" + id, harness: "claude", messageCount: 1, pinned: false, unread: false }));
    }

    function rowIds(view: var): var {
        const model = findChild(view, "conversationList").model;
        const ids = [];
        for (let index = 0; index < model.count; index++) ids.push(model.get(index).sessionId);
        return ids;
    }

    function test_reconcilesMovesInsertsAndRemovals(): void {
        Ghostd.activeGhost = "casper";
        Ghostd.sessions = tc.sessions(["a", "b", "c", "d"]);
        const view = createTemporaryObject(listComponent, tc);
        compare(tc.rowIds(view), ["a", "b", "c", "d"]);

        Ghostd.sessions = tc.sessions(["c", "a", "e", "d"]);
        compare(tc.rowIds(view), ["c", "a", "e", "d"]);

        Ghostd.sessions = tc.sessions(["d"]);
        compare(tc.rowIds(view), ["d"]);

        Ghostd.sessions = tc.sessions([]);
        compare(tc.rowIds(view), []);
    }
}
