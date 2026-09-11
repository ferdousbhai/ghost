import QtTest
import "../qml/services/TurnBlocks.js" as TurnBlocks

// The split's one job: a ghost narrating itself never lands in the reading
// column, and nothing the ghost actually said is ever lost. Every test below
// pins one of those two halves.
TestCase {
    name: "TurnBlocks"

    function textBlock(value) {
        return { kind: "text", text: value };
    }


    function test_preambleBeforeToolCallLeavesTheReply(): void {
        const blocks = {
            0: textBlock("Checking your Dropbox for the invoice."),
            2: textBlock("It is dated the 14th, for £420.")
        };
        const turn = TurnBlocks.split(blocks, [1], false);
        compare(turn.body, "It is dated the 14th, for £420.");
        compare(turn.status, "");
    }

    function test_everyPreambleGoesRegardlessOfCount(): void {
        const blocks = {
            0: textBlock("Looking that up."),
            2: textBlock("Now checking the calendar."),
            4: textBlock("Tuesday at four.")
        };
        compare(TurnBlocks.split(blocks, [1, 3], false).body, "Tuesday at four.");
    }

    function test_longBlockBeforeAToolCallIsAnswerNotStatus(): void {
        // A section of a multi-step reply happens to precede the next tool
        // call. Length is what separates it from a preamble.
        const section = "The first invoice covers hosting for the quarter and "
            + "is already settled, which is why it does not appear on the "
            + "outstanding list; the second is the one you are looking for, "
            + "and it is the one I will open next so we can read the terms.";
        const blocks = { 0: textBlock(section), 2: textBlock("Here they are.") };
        const turn = TurnBlocks.split(blocks, [1], false);
        compare(turn.body, section + "\n\nHere they are.");
    }

    function test_shortAnswerBeforeAToolCallIsNotStatus(): void {
        // Under the limit, but two sentences: the ghost answered and then kept
        // working. A preamble is one sentence, and a block ruled a preamble is
        // dropped from the settled transcript — so this one has to stay.
        const answer = "bluetooth's on and powered, nothing paired yet. put "
            + "your AirPods in pairing mode first: leave them in the case, "
            + "open the lid, hold the back button until the light blinks.";
        verify(answer.length <= 200);
        const blocks = { 0: textBlock(answer), 2: textBlock("Paired.") };
        const turn = TurnBlocks.split(blocks, [1], false);
        compare(turn.body, answer + "\n\nPaired.");
        // And it never hides beside the orb mid-turn either.
        compare(TurnBlocks.split({ 0: textBlock(answer) }, [1], true).status, "");
    }

    function test_unpunctuatedNarrationIsStillStatus(): void {
        // The commonest narration shape has no stop at all. Counting zero
        // sentences must not promote it into the reading column.
        const blocks = { 0: textBlock("Checking your Dropbox"), 2: textBlock("Found it.") };
        const turn = TurnBlocks.split(blocks, [1], false);
        compare(turn.body, "Found it.");
    }

    function test_aStopInsideAWordEndsNoSentence(): void {
        // `package.json` is not two sentences; this stays narration.
        const blocks = { 0: textBlock("Reading package.json"), 2: textBlock("Version 2.1.0 there.") };
        compare(TurnBlocks.split(blocks, [1], false).body, "Version 2.1.0 there.");
    }

    function test_theOrbDoesNotNarrateAStepAlreadyFinished(): void {
        // Two calls. The text before the second one is an answer, not a
        // preamble, so it stays in the column — and the orb must fall silent
        // rather than reach back to the narration for the *first* call, which
        // would report one step while the column describes the next.
        const blocks = {
            0: textBlock("Let me look."),
            2: textBlock("Found the file. Now I will patch it.")
        };
        const turn = TurnBlocks.split(blocks, [1, 3], true);
        compare(turn.body, "Found the file. Now I will patch it.");
        compare(turn.status, "");
    }

    function test_theOrbStillFollowsTheMostRecentNarration(): void {
        const blocks = {
            0: textBlock("Let me look."),
            2: textBlock("Now the calendar.")
        };
        compare(TurnBlocks.split(blocks, [1, 3], true).status, "Now the calendar");
    }

    function test_toolOnlyTurnKeepsItsLastWords(): void {
        // Nothing followed the calls, so the narration is all the ghost said.
        // An empty row would be worse than a slightly dull one.
        const blocks = { 0: textBlock("Saving that to memory.") };
        const turn = TurnBlocks.split(blocks, [1], false);
        compare(turn.body, "Saving that to memory.");
        compare(turn.status, "");
    }

    function test_turnWithNoToolsIsAllReply(): void {
        const blocks = { 0: textBlock("Short answer."), 1: textBlock("Longer one.") };
        const turn = TurnBlocks.split(blocks, [], false);
        compare(turn.body, "Short answer.\n\nLonger one.");
        compare(turn.status, "");
    }


    function test_liveTrailingBlockStreamsInTheColumn(): void {
        // No tool call has followed it, so it is the reply as far as anyone
        // can know; the final text is only final at the end of the stream.
        const blocks = { 0: textBlock("Checking your Dropbox") };
        const turn = TurnBlocks.split(blocks, [], true);
        compare(turn.body, "Checking your Dropbox");
        compare(turn.status, "");
    }

    function test_liveBlockMovesBesideTheOrbWhenItsToolCallStarts(): void {
        const blocks = { 0: textBlock("Checking your Dropbox") };
        const turn = TurnBlocks.split(blocks, [1], true);
        compare(turn.body, "");
        compare(turn.status, "Checking your Dropbox");
    }

    function test_liveAnswerAfterAToolCallStreamsIntoTheColumn(): void {
        const blocks = {
            0: textBlock("Checking your Dropbox."),
            2: textBlock("It is dated")
        };
        const turn = TurnBlocks.split(blocks, [1], true);
        // Text after the last call is the reply in progress; the orb stops
        // repeating the preamble and reports the runtime's state.
        compare(turn.body, "It is dated");
        compare(turn.status, "");
    }

    function test_statusIsOneLineWithoutADoubledStop(): void {
        const blocks = { 0: textBlock("Reading the page\n  for train times…") };
        compare(TurnBlocks.split(blocks, [1], true).status,
            "Reading the page for train times");
    }

    function test_blankBlocksAreNotStatus(): void {
        const turn = TurnBlocks.split({ 0: textBlock("   \n ") }, [1], false);
        compare(turn.body, "");
        compare(turn.status, "");
    }


    function test_storedPartsSplitTheSameWay(): void {
        const parts = [
            { type: "text", text: "Looking through your docs." },
            { type: "toolCall", id: "t1", name: "ghost_docs_grep" },
            { type: "text", text: "The roadmap puts launch in March." }
        ];
        compare(TurnBlocks.fromParts(parts), "The roadmap puts launch in March.");
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
