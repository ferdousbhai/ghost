import QtQuick
import QtTest
import "../qml/services/HookConfig.js" as HookConfig

TestCase {
    name: "HookConfig"

    function document(): var {
        return {
            hooks: {
                before_prompt: [
                    { hooks: [{ type: "command", command: "/bin/context" }] }
                ],
                session_stop: [
                    { hooks: [
                        { type: "command", command: "/bin/review", name: "Review", timeout: 5, statusMessage: "Reviewing" },
                        { type: "command", command: "/bin/style" }
                    ] }
                ]
            }
        };
    }

    function status(): var {
        return [
            { event: "before_prompt", name: "Before-prompt command hook", description: "Context." },
            { event: "session_stop", name: "Review", description: "Reviews." },
            { event: "session_stop", name: "Session-stop command hook", description: "Default." }
        ];
    }

    function test_parseConfigAcceptsOnlyPathAndObjectDocument(): void {
        compare(HookConfig.parseConfig(JSON.stringify({ path: "/p/hooks.json", document: {} })).path, "/p/hooks.json");
        compare(HookConfig.parseConfig(JSON.stringify({ path: "", document: {} })), null);
        compare(HookConfig.parseConfig(JSON.stringify({ path: "/p", document: [] })), null);
        compare(HookConfig.parseConfig("not json"), null);
    }

    function test_cardsPairStatusRowsWithHandlersInEventOrder(): void {
        const cards = HookConfig.cards(status(), document());
        compare(cards.map(function (card) { return card.name; }), [
            "Before-prompt command hook",
            "Review",
            "Session-stop command hook"
        ]);
        compare(cards[1].key, "config:session_stop:0:0");
        compare(cards[2].key, "config:session_stop:0:1");
        compare(cards[1].fields.command, "/bin/review");
        compare(cards[1].fields.timeout, "5");
        compare(cards[2].fields.name, "");
    }

    function test_cardsFallBackToTheDocumentWhenStatusDisagrees(): void {
        const stale = status().slice(0, 1);
        const cards = HookConfig.cards(stale, document());
        compare(cards.length, 3);
        compare(cards[0].name, "Command hook");
        compare(cards[1].name, "Review");
        compare(cards[2].name, "Command hook");
        compare(HookConfig.cards([], null).length, 0);
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
        const next = HookConfig.withHandler(document(), "before_prompt", 0, 0, {
            command: "/bin/context", name: "", description: "", timeout: "soon"
        });
        compare(next.hooks.before_prompt[0].hooks[0].timeout, "soon");
    }

    function test_withNewHandlerAppendsItsOwnGroupAndBuildsMissingStructure(): void {
        const next = HookConfig.withNewHandler({}, "before_prompt", {
            command: "/bin/ctx", name: "Context", description: "", timeout: ""
        });
        compare(next, { hooks: { before_prompt: [{ hooks: [{ type: "command", command: "/bin/ctx", name: "Context" }] }] } });
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
        compare(none.hooks.before_prompt[0].hooks[0].command, "/bin/context");
        const gone = HookConfig.withoutHandler(none, "before_prompt", 0, 0);
        compare(gone, { hooks: {} });
    }
}
