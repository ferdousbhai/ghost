import QtQuick
import QtTest
import "../qml/components"

// A peer's message is another person's text: shown as written, so markup in
// it (an image to fetch, a link to dress up) is never rendered.
TestCase {
    name: "PeerBubble"
    when: windowShown
    width: 500
    height: 300
    visible: true

    Bubble {
        id: peer

        width: 420
        speaker: "peer"
        body: "From wife · **Saturday** ![x](https://example.invalid/x.png)"
        activities: []
        failure: ""
        busy: false
        rowIndex: 0
    }

    function test_aPeerMessageIsPlainText(): void {
        verify(peer.plainBody);
        verify(!peer.mine);
        verify(!peer.hookNotice);
        compare(peer.displayBody, "From wife · **Saturday** ![x](https://example.invalid/x.png)");
    }
}
