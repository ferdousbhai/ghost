import QtTest
import "../qml/services/TurnBlocks.js" as TurnBlocks

// Every text the ghost writes stays: a message is its text parts, and a
// restored turn is cut into messages where text follows a tool call.
TestCase {
    name: "TurnBlocks"

    function t(value) {
        return { type: "text", text: value };
    }

    function call() {
        return { type: "toolCall" };
    }

    function test_aMessageIsAllItsText(): void {
        compare(TurnBlocks.fromParts([t("Short answer."), t("  "), t("Longer one.")]),
            "Short answer.\n\nLonger one.");
        compare(TurnBlocks.fromParts([t("   \n "), call()]), "");
    }

    function test_storedTextAfterAToolCallIsTheNextMessage(): void {
        const rows = TurnBlocks.rows([
            { role: "user", content: [t("when is the launch?")] },
            { role: "assistant", content: [t("Looking through your docs."), call(), call(),
                t("The roadmap puts launch in March."), t("Want the source?")] }
        ]);
        compare(rows.length, 3);
        compare(rows[1].text, "Looking through your docs.");
        compare(rows[1].parts.length, 3);
        compare(rows[2].text, "The roadmap puts launch in March.\n\nWant the source?");
    }

    function test_aCutKeepsTheTurnsErrorOnItsLastMessage(): void {
        const rows = TurnBlocks.rows([
            { role: "user", content: [t("go")] },
            { role: "assistant", content: [t("Trying."), call()] },
            { role: "assistant", content: [t("It broke.")], errorMessage: "boom" }
        ]);
        compare(rows.length, 3);
        compare(rows[1].error, "");
        compare(rows[2].error, "boom");
    }

    function test_toolOnlyTurnSurvivesWithNoTextBesideIt(): void {
        const rows = TurnBlocks.rows([
            { role: "user", content: [{ type: "text", text: "tidy it" }] },
            { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "Bash" }] },
            { role: "assistant", content: [] }
        ]);
        compare(rows.length, 2);
        compare(rows[1].role, "assistant");
        compare(rows[1].text, "");
        compare(rows[1].parts.length, 1);
    }

    function test_failedTurnKeepsItsErrorEvenWithoutText(): void {
        const rows = TurnBlocks.rows([
            { role: "user", content: [{ type: "text", text: "hello" }] },
            { role: "assistant", content: [], errorMessage: "claude usage limit reached" }
        ]);
        compare(rows.length, 2);
        compare(rows[1].error, "claude usage limit reached");
        compare(rows[0].error, undefined);
    }

    function test_storedCallsJoinThePreambleBeforeThem(): void {
        // Older projections may give each tool call its own message.
        const rows = TurnBlocks.rows([
            { role: "user", content: [{ type: "text", text: "check my repos" }], entryId: "u1" },
            { role: "assistant", content: [{ type: "text", text: "Looking now." }], entryId: "a1" },
            { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }], entryId: "a2" },
            { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "eval" }], entryId: "a3" },
            { role: "assistant", content: [{ type: "text", text: "13 repos." }], entryId: "a4" }
        ]);
        compare(rows.length, 3);
        // The preamble sat in a message of its own; regrouping puts its calls
        // beside it, and the reply after them is the next message.
        compare(rows[1].text, "Looking now.");
        compare(rows[1].parts.length, 3);
        compare(rows[2].text, "13 repos.");
    }

    function test_emptyMessagesLeaveNoRow(): void {
        const rows = TurnBlocks.rows([
            { role: "assistant", content: [], entryId: "a1" },
            { role: "user", content: [{ type: "text", text: "  " }], entryId: "u1" }
        ]);
        compare(rows.length, 0);
    }

    function test_toolOnlyRowsDoNotSwallowTheNextPrompt(): void {
        const rows = TurnBlocks.rows([
            { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }], entryId: "a1" },
            { role: "user", content: [{ type: "text", text: "second" }], entryId: "u2" },
            { role: "assistant", content: [{ type: "text", text: "done" }], entryId: "a2" }
        ]);
        compare(rows.map(row => row.role).join(","), "assistant,user,assistant");
        compare(rows[2].text, "done");
    }

    function test_aTruncatedOwnerMessageSaysSo(): void {
        const rows = TurnBlocks.rows([
            { role: "user", content: [{ type: "text", text: "long prompt" }], entryId: "u1", contentTruncated: true },
            { role: "assistant", content: [{ type: "text", text: "reply" }], entryId: "a1" }
        ]);
        compare(rows.length, 2);
        verify(rows[0].contentTruncated);
        verify(!rows[1].contentTruncated);
    }

    function test_stopHookNoticeSplitsAssistantPasses(): void {
        const rows = TurnBlocks.rows([
            { role: "user", content: [{ type: "text", text: "Reply exactly." }], entryId: "u1" },
            { role: "assistant", content: [{ type: "text", text: "Ready." }], entryId: "a1" },
            { role: "hook", content: [{ type: "text", text: "Keep going." }], entryId: "h1" },
            { role: "assistant", content: [{ type: "text", text: "Ready." }], entryId: "a2" }
        ]);
        compare(rows.map(row => row.role).join(","), "user,assistant,hook,assistant");
        compare(rows[2].text, "Keep going.");
    }
}
