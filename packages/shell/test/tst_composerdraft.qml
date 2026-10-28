import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

// The composer's `+` asks for a fresh conversation, and text ghostd hands back
// joins the draft rather than replacing it.
TestCase {
    name: "ComposerDraft"
    when: windowShown
    width: 400
    height: 600
    visible: true

    Composer {
        id: composer
        x: 0
        y: 540
        width: 300
        height: 48
    }

    SignalSpy { id: requested; target: composer; signalName: "newConversationRequested" }

    function init(): void {
        Ghostd.turnStates = ({});
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.sessions = [];
        requested.clear();
    }

    function cleanup(): void {
        Ghostd.turnStates = ({});
        Ghostd.currentSessionId = "";
        Ghostd.sessions = [];
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

    function test_composeButtonAsksForANewConversation(): void {
        mouseClick(composer, 18, 24);
        compare(requested.count, 1);
    }
}
