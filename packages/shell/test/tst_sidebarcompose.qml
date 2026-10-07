import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

// The composer's `+` and Ctrl+N share one entry point: a fresh conversation,
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

    Composer {
        id: composer
        x: 0
        y: 540
        width: 300
        height: 48
        onNewConversationRequested: sidebar.startConversation()
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

    // A stop or a refused follow-up hands text back; what the owner typed since stays.
    function test_restoredTextKeepsTheDraft(): void {
        composer.text = "";
        composer.restore("queued");
        compare(composer.text, "queued");
        composer.text = "typed since";
        composer.restore("queued");
        compare(composer.text, "queued\n\ntyped since");
        composer.text = "";
    }

    function test_composeButtonOpensADraft(): void {
        mouseClick(composer, 18, 24);
        verify(Ghostd.currentSessionId !== "");
        compare(refocused.count, 1);
    }
}
