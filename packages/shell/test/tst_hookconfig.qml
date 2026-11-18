import QtQuick
import QtTest
import "../qml/services/HookConfig.js" as HookConfig

TestCase {
    name: "HookConfig"

    function document(): var {
        return {
            hooks: {
                session_stop: [
                    { hooks: [
                        { type: "command", command: "/bin/review", name: "Review", timeout: 5, statusMessage: "Reviewing" },
                        { type: "command", command: "/bin/style" }
                    ] }
                ],
                turn_end: [
                    { hooks: [{ type: "command", command: "/bin/notify" }] }
                ]
            }
        };
    }

    function test_parseConfigAcceptsOnlyPathAndObjectDocument(): void {
        compare(HookConfig.parseConfig({ path: "/p/hooks.json", document: {} }).path, "/p/hooks.json");
        compare(HookConfig.parseConfig({ path: "", document: {} }), null);
        compare(HookConfig.parseConfig({ path: "/p", document: [] }), null);
        compare(HookConfig.parseConfig(undefined), null);
    }

    function test_cardsFollowTheDocumentWithTheDaemonsDefaults(): void {
        const cards = HookConfig.cards(document());
        compare(cards.map(function (card) { return card.name; }), [
            "Review",
            "Session-stop command hook",
            "Turn-end command hook"
        ]);
        compare(cards[2].description, "Observes final turn success or failure without continuing it.");
        compare(cards[1].description, "Runs after the assistant pass and may continue it.");
        compare(cards[0].key, "config:session_stop:0:0");
        compare(cards[1].key, "config:session_stop:0:1");
        compare(cards[0].fields.command, "/bin/review");
        compare(cards[0].fields.timeout, "5");
        compare(cards[1].fields.name, "");
        compare(HookConfig.cards(null).length, 0);
    }

    function test_withHandlerKeepsUnknownKeysAndDropsEmptiedOptionals(): void {
        const before = document();
        const next = HookConfig.withHandler(before, "session_stop", 0, 0, {
            command: "/bin/review --strict", name: "", description: "Strict review", timeout: "12"
        });
        const handler = next.hooks.session_stop[0].hooks[0];
        compare(handler, {
            type: "command", command: "/bin/review --strict", description: "Strict review",
            timeout: 12, statusMessage: "Reviewing"
        });
        // The input document is never mutated.
        compare(before.hooks.session_stop[0].hooks[0].name, "Review");
        verify(!HookConfig.same(before, next));
    }

    function test_numbersThatDoNotParseGoToTheDaemonAsTyped(): void {
        const next = HookConfig.withHandler(document(), "turn_end", 0, 0, {
            command: "/bin/notify", name: "", description: "", timeout: "soon"
        });
        compare(next.hooks.turn_end[0].hooks[0].timeout, "soon");
    }

    function test_withNewHandlerAppendsItsOwnGroupAndBuildsMissingStructure(): void {
        const next = HookConfig.withNewHandler({}, "turn_end", {
            command: "/bin/ntfy", name: "Notify", description: "", timeout: ""
        });
        compare(next, { hooks: { turn_end: [{ hooks: [{ type: "command", command: "/bin/ntfy", name: "Notify" }] }] } });
        const appended = HookConfig.withNewHandler(document(), "session_stop", {
            command: "/bin/more", name: "", description: "", timeout: ""
        });
        compare(appended.hooks.session_stop.length, 2);
        compare(appended.hooks.session_stop[1].hooks[0].command, "/bin/more");
    }

    function test_withoutHandlerPrunesEmptyGroupsAndEvents(): void {
        const one = HookConfig.withoutHandler(document(), "session_stop", 0, 0);
        compare(one.hooks.session_stop[0].hooks.length, 1);
        compare(one.hooks.session_stop[0].hooks[0].command, "/bin/style");
        const none = HookConfig.withoutHandler(one, "session_stop", 0, 0);
        verify(none.hooks.session_stop === undefined);
        compare(none.hooks.turn_end[0].hooks[0].command, "/bin/notify");
        const gone = HookConfig.withoutHandler(none, "turn_end", 0, 0);
        compare(gone, { hooks: {} });
    }
}
