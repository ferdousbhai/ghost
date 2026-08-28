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
                conversation_idle: [
                    { hooks: [{ type: "command", command: "/bin/idle", idleSeconds: 120 }] }
                ]
            }
        };
    }

    function status(): var {
        return [
            { event: "before_prompt", source: "builtin", name: "Receipt", description: "Shows receipts." },
            { event: "session_stop", source: "config", name: "Review", description: "Reviews." },
            { event: "session_stop", source: "config", name: "Session-stop command hook", description: "Default." },
            { event: "conversation_idle", source: "builtin", name: "Memory upkeep", description: "Upkeep.", idleSeconds: 60, settingsKey: "memory_upkeep" },
            { event: "conversation_idle", source: "config", name: "Conversation-idle command hook", description: "Idle.", idleSeconds: 120 }
        ];
    }

    function test_parseConfigAcceptsOnlyPathAndObjectDocument(): void {
        compare(HookConfig.parseConfig(JSON.stringify({ path: "/p/hooks.json", document: {} })).path, "/p/hooks.json");
        compare(HookConfig.parseConfig(JSON.stringify({ path: "", document: {} })), null);
        compare(HookConfig.parseConfig(JSON.stringify({ path: "/p", document: [] })), null);
        compare(HookConfig.parseConfig("not json"), null);
    }

    function test_cardsInterleaveBuiltinAndConfigInEventOrder(): void {
        const cards = HookConfig.cards(status(), document());
        compare(cards.map(function (card) { return card.source + ":" + card.name; }), [
            "builtin:Receipt",
            "config:Review",
            "config:Session-stop command hook",
            "builtin:Memory upkeep",
            "config:Conversation-idle command hook"
        ]);
        compare(cards[1].key, "config:session_stop:0:0");
        compare(cards[2].key, "config:session_stop:0:1");
        compare(cards[1].command, "/bin/review");
        compare(cards[1].fields.timeout, "5");
        compare(cards[2].fields.name, "");
        compare(cards[4].idleSeconds, 120);
        compare(cards[0].command, "");
        compare(cards[0].groupIndex, -1);
    }

    function test_cardsFallBackToTheDocumentWhenStatusDisagrees(): void {
        const stale = status().slice(0, 1);
        const cards = HookConfig.cards(stale, document());
        compare(cards.length, 4);
        compare(cards[1].name, "Review");
        compare(cards[2].name, "Command hook");
        compare(cards[3].idleSeconds, 120);
        compare(HookConfig.cards([], null).length, 0);
    }

    function test_withHandlerKeepsUnknownKeysAndDropsEmptiedOptionals(): void {
        const before = document();
        const next = HookConfig.withHandler(before, "session_stop", 0, 0, {
            command: "/bin/review --strict", name: "", description: "Strict review", timeout: "12", idleSeconds: "99"
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
        const next = HookConfig.withHandler(document(), "conversation_idle", 0, 0, {
            command: "/bin/idle", name: "", description: "", timeout: "soon", idleSeconds: "5m"
        });
        compare(next.hooks.conversation_idle[0].hooks[0].timeout, "soon");
        compare(next.hooks.conversation_idle[0].hooks[0].idleSeconds, "5m");
    }

    function test_withNewHandlerAppendsItsOwnGroupAndBuildsMissingStructure(): void {
        const next = HookConfig.withNewHandler({}, "before_prompt", {
            command: "/bin/ctx", name: "Context", description: "", timeout: "", idleSeconds: "30"
        });
        compare(next, { hooks: { before_prompt: [{ hooks: [{ type: "command", command: "/bin/ctx", name: "Context" }] }] } });
        const appended = HookConfig.withNewHandler(document(), "session_stop", {
            command: "/bin/more", name: "", description: "", timeout: "", idleSeconds: ""
        });
        compare(appended.hooks.session_stop.length, 2);
        compare(appended.hooks.session_stop[1].hooks[0].command, "/bin/more");
    }

    function test_builtinTuningIsReadFromTheDocumentAndPendingUntilRestart(): void {
        const untuned = HookConfig.cards(status(), document());
        compare(untuned[3].settingsKey, "memory_upkeep");
        compare(untuned[3].fields.idleSeconds, "");
        compare(untuned[3].pendingIdleSeconds, 0);
        compare(untuned[0].settingsKey, "");

        const tunedDocument = document();
        tunedDocument.builtin = { memory_upkeep: { idleSeconds: 900 } };
        const tuned = HookConfig.cards(status(), tunedDocument);
        compare(tuned[3].fields.idleSeconds, "900");
        compare(tuned[3].idleSeconds, 60);
        compare(tuned[3].pendingIdleSeconds, 900);
        tunedDocument.builtin.memory_upkeep.idleSeconds = 60;
        compare(HookConfig.cards(status(), tunedDocument)[3].pendingIdleSeconds, 0);

        const set = HookConfig.withBuiltinIdle(document(), "memory_upkeep", { idleSeconds: " 900 " });
        compare(set.builtin, { memory_upkeep: { idleSeconds: 900 } });
        compare(set.hooks.session_stop.length, 1);
        const asTyped = HookConfig.withBuiltinIdle(set, "memory_upkeep", { idleSeconds: "15m" });
        compare(asTyped.builtin.memory_upkeep.idleSeconds, "15m");
        const cleared = HookConfig.withBuiltinIdle(set, "memory_upkeep", { idleSeconds: "" });
        verify(cleared.builtin === undefined);
    }

    function test_withoutHandlerPrunesEmptyGroupsAndEvents(): void {
        const one = HookConfig.withoutHandler(document(), "session_stop", 0, 0);
        compare(one.hooks.session_stop[0].hooks.length, 1);
        compare(one.hooks.session_stop[0].hooks[0].command, "/bin/style");
        const none = HookConfig.withoutHandler(one, "session_stop", 0, 0);
        verify(none.hooks.session_stop === undefined);
        compare(none.hooks.conversation_idle[0].hooks[0].command, "/bin/idle");
        const gone = HookConfig.withoutHandler(none, "conversation_idle", 0, 0);
        compare(gone, { hooks: {} });
    }
}
