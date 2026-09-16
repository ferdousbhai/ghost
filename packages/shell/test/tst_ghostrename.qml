import QtQuick
import QtTest
import "../qml/services/GhostRename.js" as GhostRename

TestCase {
    name: "GhostRename"

    function fixtureState(): var {
        return {
            ghosts: [
                { name: "Casper", dir: "/tmp/ghosts/Casper", createdAt: "old" },
                { name: "Wendy", dir: "/tmp/ghosts/Wendy", createdAt: "new" }
            ],
            sessionIds: { Casper: "casper-chat", Wendy: "wendy-chat" },
            commandExchanges: {
                "Casper\ncasper-chat": [{ output: "casper" }],
                "Wendy\nwendy-chat": [{ output: "wendy" }]
            },
            commandTurnKey: "Casper\ncasper-chat",
            greetingGhost: "Casper",
            loginGhost: "Casper",
            commandsGhost: "Casper",
            mcpGhost: "Casper",
            activeGhost: "Casper",
            characterGhost: "Casper"
        };
    }

    function test_existingTargetNeverEntersOptimisticState(): void {
        const original = fixtureState();
        const before = JSON.stringify(original);
        const transaction = GhostRename.prepare(original, "Casper", "Wendy");

        verify(!transaction.ok);
        compare(transaction.code, "already_exists");
        compare(JSON.stringify(original), before);
        compare(transaction.before.ghosts[0].name, "Casper");
        compare(transaction.before.ghosts[1].name, "Wendy");
        compare(transaction.before.sessionIds.Casper, "casper-chat");
        compare(transaction.before.sessionIds.Wendy, "wendy-chat");
    }

    function test_failedNonCollisionRestoresExactState(): void {
        const original = fixtureState();
        original.ghosts.pop();
        delete original.sessionIds.Wendy;
        delete original.commandExchanges["Wendy\nwendy-chat"];
        const expected = JSON.stringify(original);
        const transaction = GhostRename.prepare(original, "Casper", "Spooky");

        verify(transaction.ok);
        compare(transaction.after.ghosts[0].name, "Spooky");
        compare(transaction.after.sessionIds.Spooky, "casper-chat");
        verify(!("Casper" in transaction.after.sessionIds));
        compare(JSON.stringify(GhostRename.rollback(transaction)), expected);
    }

    function test_successRekeysEverySessionScopedOwnerOnce(): void {
        const original = fixtureState();
        original.ghosts.pop();
        delete original.sessionIds.Wendy;
        delete original.commandExchanges["Wendy\nwendy-chat"];
        const transaction = GhostRename.prepare(original, "Casper", "Spooky");
        const renamed = transaction.after;

        compare(Object.keys(renamed.sessionIds).join(","), "Spooky");
        compare(Object.keys(renamed.commandExchanges).join(","), "Spooky\ncasper-chat");
        compare(renamed.commandTurnKey, "Spooky\ncasper-chat");
        compare(renamed.ghosts[0].dir, "/tmp/ghosts/Spooky");
        for (const owner of [
            "greetingGhost", "loginGhost", "commandsGhost", "mcpGhost",
            "activeGhost", "characterGhost"
        ]) compare(renamed[owner], "Spooky");
    }
}
