import QtTest
import "../qml/services/TurnBlocks.js" as TurnBlocks

// The split's one job: the reading column shows the latest text of the turn,
// and nothing the ghost actually said is ever lost — what a tool call
// overwrote becomes that call's caption. Every test below pins one of those
// two halves.
TestCase {
    name: "TurnBlocks"

    function textBlock(value) {
        return { kind: "text", text: value };
    }


    function test_textAfterTheLastToolCallIsTheReply(): void {
        const blocks = {
            0: textBlock("Checking your Dropbox for the invoice."),
            2: textBlock("It is dated the 14th, for £420.")
        };
        const turn = TurnBlocks.split(blocks, [1]);
        compare(turn.body, "It is dated the 14th, for £420.");
        compare(turn.captions[1], "Checking your Dropbox for the invoice.");
    }

    function test_eachToolCallOverwritesTheTextBeforeIt(): void {
        const blocks = {
            0: textBlock("Looking that up."),
            2: textBlock("Now checking the calendar."),
            4: textBlock("Tuesday at four.")
        };
        const turn = TurnBlocks.split(blocks, [1, 3]);
        compare(turn.body, "Tuesday at four.");
        compare(turn.captions[1], "Looking that up.");
        compare(turn.captions[3], "Now checking the calendar.");
    }

    function test_lengthAndSentenceCountDoNotMatter(): void {
        // No classifier: a long, multi-sentence section before a call is
        // overwritten like any other, and survives as the call's caption.
        const section = "The first invoice covers hosting for the quarter and "
            + "is already settled, which is why it does not appear on the "
            + "outstanding list; the second is the one you are looking for, "
            + "and it is the one I will open next so we can read the terms.";
        const blocks = { 0: textBlock(section), 2: textBlock("Here they are.") };
        const turn = TurnBlocks.split(blocks, [1]);
        compare(turn.body, "Here they are.");
        compare(turn.captions[1], section);
    }

    function test_liveTextBeforeAnyCallStreamsInTheColumn(): void {
        const turn = TurnBlocks.split({ 0: textBlock("Checking your Dropbox") }, []);
        compare(turn.body, "Checking your Dropbox");
        compare(Object.keys(turn.captions).length, 0);
    }

    function test_theColumnKeepsTheAnnouncementWhileItsCallRuns(): void {
        // The call has started and nothing has followed it yet: the latest
        // text stays on screen rather than the column going blank.
        const turn = TurnBlocks.split({ 0: textBlock("Checking your Dropbox") }, [1]);
        compare(turn.body, "Checking your Dropbox");
        compare(turn.captions[1], "Checking your Dropbox");
    }

    function test_toolOnlyTurnKeepsItsLastWords(): void {
        // Nothing followed the calls, so the narration is all the ghost said.
        const blocks = { 0: textBlock("Saving that to memory.") };
        compare(TurnBlocks.split(blocks, [1]).body, "Saving that to memory.");
    }

    function test_turnWithNoToolsIsAllReply(): void {
        const blocks = { 0: textBlock("Short answer."), 1: textBlock("Longer one.") };
        compare(TurnBlocks.split(blocks, []).body, "Short answer.\n\nLonger one.");
    }

    function test_severalBlocksAfterTheLastCallAreOneReply(): void {
        const blocks = {
            0: textBlock("Reading it."),
            2: textBlock("First part."),
            3: textBlock("Second part.")
        };
        compare(TurnBlocks.split(blocks, [1]).body, "First part.\n\nSecond part.");
    }

    function test_parallelCallsShareOneAnnouncement(): void {
        const blocks = { 0: textBlock("Checking both calendars."), 3: textBlock("Both free.") };
        const turn = TurnBlocks.split(blocks, [1, 2]);
        compare(turn.captions[1], "Checking both calendars.");
        compare(turn.captions[2], "Checking both calendars.");
    }

    function test_aSilentCallHasNoCaption(): void {
        const blocks = { 1: textBlock("Done.") };
        const turn = TurnBlocks.split(blocks, [0]);
        compare(turn.captions[0], "");
        compare(turn.body, "Done.");
    }

    function test_captionsAreOneLine(): void {
        const blocks = { 0: textBlock("Reading the page\n  for train times…") };
        compare(TurnBlocks.split(blocks, [1]).captions[1], "Reading the page for train times…");
    }

    function test_blankBlocksAreNothing(): void {
        const turn = TurnBlocks.split({ 0: textBlock("   \n ") }, [1]);
        compare(turn.body, "");
        compare(turn.captions[1], "");
    }

    function test_toolIndicesArriveAsStrings(): void {
        // The live buffer keys tool calls by Object.keys, so they come as text.
        const blocks = { 0: textBlock("Looking."), 2: textBlock("Found.") };
        const turn = TurnBlocks.split(blocks, ["1"]);
        compare(turn.body, "Found.");
        compare(turn.captions[1], "Looking.");
    }


    function test_storedPartsSplitTheSameWay(): void {
        const parts = [
            { type: "text", text: "Looking through your docs." },
            { type: "toolCall", id: "t1", name: "ghost_docs_grep" },
            { type: "text", text: "The roadmap puts launch in March." }
        ];
        compare(TurnBlocks.fromParts(parts), "The roadmap puts launch in March.");
        compare(TurnBlocks.splitParts(parts).captions[1], "Looking through your docs.");
    }

    function test_storedUserMessageSurvivesWhole(): void {
        // No tool calls, so nothing can be mistaken for narration.
        const parts = [{ type: "text", text: "when is the launch?" }];
        compare(TurnBlocks.fromParts(parts), "when is the launch?");
    }


    function test_unansweredAskSurvivesWithNoTextBesideIt(): void {
        // The shape that broke a real conversation: the app closed on an open
        // question, so the turn's last message is a lone `ask` call. Drop that
        // row and the card's re-answer branch goes with it, leaving a question
        // nobody can ever answer.
        const rows = TurnBlocks.rows([
            { role: "user", content: [{ type: "text", text: "let's delete it" }], entryId: "u1" },
            {
                role: "assistant",
                entryId: "a1",
                content: [{
                    type: "toolCall",
                    id: "call_1",
                    name: "ask",
                    ghostAsk: { index: 0, count: 1, resultEntryId: "c8495d57" }
                }]
            },
            { role: "assistant", content: [], entryId: "a2" }
        ]);
        compare(rows.length, 2);
        compare(rows[1].role, "assistant");
        compare(rows[1].text, "");
        compare(rows[1].parts.length, 1);
        compare(rows[1].parts[0].name, "ask");
        compare(rows[1].parts[0].ghostAsk.resultEntryId, "c8495d57");
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
        // made it one; regrouping is what lets the split see them together.
        compare(rows[1].text, "13 repos.");
        compare(rows[1].parts.length, 4);
        // The row answers as the turn started, so a rewind lands where it should.
        compare(rows[1].entryId, "a1");
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
            { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "ask" }], entryId: "a1" },
            { role: "user", content: [{ type: "text", text: "second" }], entryId: "u2" },
            { role: "assistant", content: [{ type: "text", text: "done" }], entryId: "a2" }
        ]);
        compare(rows.map(row => row.role).join(","), "assistant,user,assistant");
        compare(rows[2].text, "done");
    }

    function test_stringContentStillReadsAsARow(): void {
        const rows = TurnBlocks.rows([{ role: "user", content: "plain string", entryId: "u1" }]);
        compare(rows.length, 1);
        compare(rows[0].text, "plain string");
    }

    function test_savedTextTruncationSurvivesAssistantGrouping(): void {
        const rows = TurnBlocks.rows([
            { role: "user", content: "whole prompt", entryId: "u1" },
            { role: "assistant", content: "first", entryId: "a1" },
            { role: "assistant", content: "second", entryId: "a2", contentTruncated: true }
        ]);
        compare(rows.length, 2);
        verify(!rows[0].contentTruncated);
        verify(rows[1].contentTruncated);
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
