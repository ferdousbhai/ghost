import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as Xhr

TestCase {
    name: "ReadVisibility"
    property var reads: []
    function init(): void {
        reads = [];
        Ghostd.requestFactory = Xhr.factory(reads, /\/read$/);
        Ghostd.hudChatFocused = false;
        Ghostd.hudVisible = true;
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "one";
        Ghostd.sessions = [{ id: "one", unread: true }];
    }
    function cleanup(): void {
        Ghostd.hudChatFocused = false;
        Ghostd.requestFactory = null;
    }
    function test_visibleBoardDoesNotMarkRead(): void {
        Ghostd.markCurrentConversationRead();
        compare(reads.length, 0);
        verify(Ghostd.sessions[0].unread);
        Ghostd.hudChatFocused = true;
        compare(reads.length, 1);
        verify(!Ghostd.sessions[0].unread);
    }
    function test_selectingConversationWithoutFocusedChatDoesNotMarkRead(): void {
        Ghostd.finishOpenConversation("one");
        compare(reads.length, 0);
        verify(Ghostd.sessions[0].unread);
    }
}
