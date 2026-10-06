import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

// The sidebar's `+` and Ctrl+N share one entry point: a fresh conversation,
// the search field cleared, and the keyboard handed back to the composer.
TestCase {
    name: "SidebarCompose"
    when: windowShown
    width: 400
    height: 600
    visible: true

    Sidebar {
        id: sidebar
        width: 300
        height: 600
    }

    SignalSpy { id: refocused; target: sidebar; signalName: "refocused" }

    function init(): void {
        Ghostd.turnStates = ({});
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.sessions = [];
        refocused.clear();
    }

    function cleanup(): void {
        Ghostd.turnStates = ({});
        Ghostd.currentSessionId = "";
        Ghostd.sessions = [];
    }

    function test_startConversationOpensADraftAndRefocuses(): void {
        sidebar.startConversation();
        verify(Ghostd.currentSessionId !== "");
        compare(Ghostd.sessions.length, 1);
        compare(Ghostd.sessions[0].messageCount, 0);
        compare(refocused.count, 1);
    }
}
