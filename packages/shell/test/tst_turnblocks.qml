import QtTest
import "../qml/services/TurnBlocks.js" as TurnBlocks

// The reply rule's one job: the reading column shows the latest text of the
// turn. Text a tool call followed holds the column until the next text
// replaces it.
TestCase {
    name: "TurnBlocks"

    function t(value) {
        return { type: "text", text: value };
    }

    function call() {
        return { type: "toolCall" };
    }

    function test_textAfterTheLastToolCallIsTheReply(): void {
        compare(TurnBlocks.fromParts([t("Checking your Dropbox for the invoice."), call(), t("It is dated the 14th, for £420.")]),
            "It is dated the 14th, for £420.");
    }

    function test_eachToolCallOverwritesTheTextBeforeIt(): void {
        compare(TurnBlocks.fromParts([t("Looking that up."), call(), t("Now checking the calendar."), call(), t("Tuesday at four.")]),
            "Tuesday at four.");
    }

    function test_lengthAndSentenceCountDoNotMatter(): void {
        // No classifier: a long, multi-sentence section before a call is
        // replaced like any other.
        const section = "The first invoice covers hosting for the quarter and "
            + "is already settled, which is why it does not appear on the "
            + "outstanding list; the second is the one you are looking for, "
            + "and it is the one I will open next so we can read the terms.";
        compare(TurnBlocks.fromParts([t(section), call(), t("Here they are.")]), "Here they are.");
    }

    function test_theColumnKeepsTheAnnouncementWhileItsCallRuns(): void {
        // The call has started and nothing has followed it yet: the latest
        // text stays on screen rather than the column going blank. A turn
        // that ends there keeps it as its last words.
        compare(TurnBlocks.fromParts([t("Checking your Dropbox")]), "Checking your Dropbox");
        compare(TurnBlocks.fromParts([t("Checking your Dropbox"), call()]), "Checking your Dropbox");
    }

    function test_turnWithNoToolsIsAllReply(): void {
        compare(TurnBlocks.fromParts([t("Short answer."), t("Longer one.")]), "Short answer.\n\nLonger one.");
    }

    function test_severalPartsAfterTheLastCallAreOneReply(): void {
        compare(TurnBlocks.fromParts([t("Reading it."), call(), t("First part."), t("Second part.")]),
            "First part.\n\nSecond part.");
    }

    function test_parallelCallsReplaceOneAnnouncement(): void {
        compare(TurnBlocks.fromParts([t("Checking both calendars."), call(), call(), t("Both free.")]), "Both free.");
    }

    function test_blankTextIsNothing(): void {
        compare(TurnBlocks.fromParts([t("   \n "), call()]), "");
        compare(TurnBlocks.fromParts([t("Looking."), call(), t("  ")]), "Looking.");
    }

    function test_storedUserMessageSurvivesWhole(): void {
        // No tool calls, so nothing can be mistaken for narration.
        const parts = [{ type: "text", text: "when is the launch?" }];
        compare(TurnBlocks.fromParts(parts), "when is the launch?");
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

    function test_oneTurnSplitAcrossMessagesBecomesOneRow(): void {
        // Older projections may give each tool call its own message.
        const rows = TurnBlocks.rows([
            { role: "user", content: [{ type: "text", text: "check my repos" }], entryId: "u1" },
            { role: "assistant", content: [{ type: "text", text: "Looking now." }], entryId: "a1" },
            { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }], entryId: "a2" },
            { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "eval" }], entryId: "a3" },
            { role: "assistant", content: [{ type: "text", text: "13 repos." }], entryId: "a4" }
        ]);
        compare(rows.length, 2);
        // The preamble sat in a message of its own, severed from the call that
        // made it one; regrouping is what lets the reply rule see them together.
        compare(rows[1].text, "13 repos.");
        compare(rows[1].parts.length, 4);
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

    function test_unknownRolesAreSkippedWithoutBreakingTheGrouping(): void {
        const rows = TurnBlocks.rows([
            { role: "assistant", content: [{ type: "text", text: "Reading." }], entryId: "a1" },
            { role: "toolResult", content: [{ type: "text", text: "internal" }] },
            { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }], entryId: "a2" }
        ]);
        compare(rows.length, 1);
        // The internal message did not break the run, so both assistant
        // messages landed in one row and the call is beside its narration.
        compare(rows[0].parts.length, 2);
        // Narration is all this turn said, so it keeps it rather than showing
        // an empty row — the tool-only fallback, reached through grouping.
        compare(rows[0].text, "Reading.");
    }

    function test_storedPartsIgnoreUnknownKinds(): void {
        const parts = [
            { type: "thinking", text: "hmm" },
            { type: "text", text: "Right — March." }
        ];
        compare(TurnBlocks.fromParts(parts), "Right — March.");
    }
}
