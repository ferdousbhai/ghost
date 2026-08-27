import QtQuick
import QtTest
import "../qml/TrayActions.js" as TrayActions

TestCase {
    name: "TrayActions"

    function harness(): var {
        const calls = [];
        return {
            calls: calls,
            ghostd: {
                selectGhost: name => calls.push("ghost:" + name),
                openConversation: id => calls.push("conversation:" + id),
                openConversationForGhost: (name, id) =>
                    calls.push("ghost-conversation:" + name + ":" + id),
                newConversationForGhost: name => calls.push("ghost-new:" + name),
                newConversation: () => calls.push("new")
            },
            hud: {
                toggle: () => calls.push("toggle"),
                open: () => calls.push("open"),
                openSwitcher: () => calls.push("switcher"),
                openLogin: () => calls.push("login")
            },
            quit: () => calls.push("quit")
        };
    }

    function test_conversationSelectsGhostThenThreadThenRevealsHud(): void {
        const h = harness();
        verify(TrayActions.dispatch({
            action: "conversation", name: "casper", sessionId: "conv-2"
        }, h.ghostd, h.hud, h.quit));
        compare(h.calls.join(","), "ghost-conversation:casper:conv-2,open");
    }

    function test_newConversationAndStandingActionsRouteOnce(): void {
        const h = harness();
        verify(TrayActions.dispatch({ action: "new", name: "casper" },
            h.ghostd, h.hud, h.quit));
        verify(TrayActions.dispatch({ action: "switcher" }, h.ghostd, h.hud, h.quit));
        verify(TrayActions.dispatch({ action: "quit" }, h.ghostd, h.hud, h.quit));
        compare(h.calls.join(","), "ghost-new:casper,open,open,switcher,quit");
    }

    function test_unknownActionIsRejectedWithoutSideEffects(): void {
        const h = harness();
        verify(!TrayActions.dispatch({ action: "summon" }, h.ghostd, h.hud, h.quit));
        compare(h.calls.length, 0);
    }
}
