import QtQuick
import QtTest
import "../qml/components"

TestCase {
    id: tc
    name: "BubbleOrder"
    when: windowShown
    width: 600
    height: 400
    visible: true

    // A row's text is what the ghost said before its calls, so it reads first.
    Bubble {
        id: bubble
        width: 500
        speaker: "assistant"
        body: "Let me check what is available."
        activities: [{ id: "a", name: "bash", status: "failed", arguments: { command: "which x" }, summary: "" }]
        failure: ""
        busy: false
        rowIndex: 0
    }

    function find(item: var, test: var): var {
        if (test(item)) return item;
        for (let i = 0; i < item.children.length; i++) {
            const hit = tc.find(item.children[i], test);
            if (hit) return hit;
        }
        return null;
    }

    function test_toolCardsFollowTheText(): void {
        const message = tc.find(bubble, item => item.objectName === "messageHoverArea");
        const card = tc.find(bubble, item => item.activity !== undefined && item !== bubble);
        verify(message && message.visible);
        verify(card && card.visible);
        tryVerify(() => message.height > 0 && card.height > 0);
        verify(card.mapToItem(bubble, 0, 0).y >= message.mapToItem(bubble, 0, message.height).y);
    }
}
