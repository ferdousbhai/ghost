import QtQuick
import QtTest

// Bubble's reply body leans on three Qt behaviours that no property of ours
// would catch breaking: markdown honours Text.lineHeight, links keep the colour
// we hand them, and a hover-only MouseArea laid over the text does not swallow
// the click that activates a link. Bubble itself needs the `qs` module that
// only Quickshell synthesises, so the contract is pinned on a bare Text.
TestCase {
    id: tc
    name: "MarkdownBody"
    when: windowShown
    width: 320
    height: 200
    visible: true

    property string activated: ""

    readonly property string sample:
        "# Heading\n\nBody copy long enough to wrap across more than one line in "
        + "this column.\n\n- one\n- two\n\n> quoted\n\n`code` and [a link](https://example.com)\n"

    // The measured pair sits below the window: a Text carrying a link accepts
    // mouse events, and an overlapping one would eat the click test's press.
    Text {
        id: tight
        y: 400
        width: 300
        textFormat: Text.MarkdownText
        wrapMode: Text.Wrap
        font.pixelSize: 14
        text: tc.sample
    }

    Text {
        id: airy
        y: 800
        width: 300
        textFormat: Text.MarkdownText
        wrapMode: Text.Wrap
        font.pixelSize: 14
        lineHeight: 1.35
        text: tc.sample
    }

    Text {
        id: body
        anchors.fill: parent
        textFormat: Text.MarkdownText
        wrapMode: Text.Wrap
        font.pixelSize: 14
        lineHeight: 1.35
        linkColor: "#fbbf24"
        text: "[a link](https://example.com)"
        onLinkActivated: link => tc.activated = link

        MouseArea {
            anchors.fill: parent
            acceptedButtons: Qt.NoButton
            cursorShape: body.hoveredLink !== "" ? Qt.PointingHandCursor : Qt.ArrowCursor
        }
    }

    function test_lineHeightReachesMarkdown(): void {
        verify(airy.contentHeight > tight.contentHeight);
    }

    function test_hoverOverlayLeavesLinksClickable(): void {
        mouseMove(body, 20, 8);
        compare(body.hoveredLink, "https://example.com");
        mouseClick(body, 20, 8);
        compare(tc.activated, "https://example.com");
    }
}
