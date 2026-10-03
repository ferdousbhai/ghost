import QtQuick
import QtTest
import "../qml"
import "../qml/services"

TestCase {
    name: "Notifications"
    Service { id: service }
    property var sender: null

    function init(): void {
        sender = findChild(Notifier, "notificationSender");
        verify(sender !== null);
        sender.running = false;
        Notifier.pending = [];
        Notifier.notificationIds = ({});
        Notifier.enabled = true;
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "one";
        Ghostd.hudChatFocused = true;
    }

    function cleanup(): void {
        sender.running = false;
        Notifier.pending = [];
        Ghostd.hudChatFocused = false;
    }

    function test_suppressesOnlyTheViewedConversation(): void {
        Ghostd.turnFinished("casper", "Done", "one", "First");
        verify(!sender.running);
        Ghostd.turnFinished("casper", "Background finished", "two", "Second");
        verify(sender.running);
        compare(sender.command.slice(-2), ["casper · Second", "Background finished"]);
    }

    function test_unfocusedChatStillNotifies(): void {
        Ghostd.hudChatFocused = false;
        Ghostd.turnFailed("casper", "Sign in to continue", "one", "First");
        verify(sender.running);
        verify(sender.command.includes("--urgency=critical"));
    }

    function test_replacesWithinConversationAndKeepsOthersIndependent(): void {
        Notifier.turnFinished("casper", "one", "First", "Done");
        sender.stdout.read("41");
        Notifier.turnFailed("casper", "one", "First", "Stopped");
        Notifier.turnFinished("casper", "two", "Second", "Other done");
        compare(Notifier.pending.length, 2);
        sender.simulateExited();
        tryVerify(() => sender.running);
        verify(sender.command.includes("--replace-id=41"));
        compare(sender.command.slice(-1)[0], "Stopped");
        sender.stdout.read("41");
        sender.simulateExited();
        tryVerify(() => sender.running);
        verify(sender.command.includes("--replace-id=0"));
        compare(sender.command.slice(-2)[0], "casper · Second");
    }

    function test_pendingUpdatesKeepOnlyTheLatestToastForEachConversation(): void {
        Notifier.turnFinished("casper", "one", "First", "Done");
        Notifier.turnFailed("casper", "one", "First", "Stopped");
        Notifier.turnFinished("casper", "one", "First", "Already answered");
        sender.stdout.read("41");
        sender.simulateExited();
        tryVerify(() => sender.running);
        compare(sender.command.slice(-1)[0], "Already answered");
        verify(sender.command.includes("--replace-id=41"));
        compare(Notifier.pending.length, 0);
    }
}
