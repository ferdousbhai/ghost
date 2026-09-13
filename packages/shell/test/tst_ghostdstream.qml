import QtQuick
import QtTest
import "../qml/services"

// Single-conversation stream settlement, driven through the real per-turn
// path (ensureTurnState / beginTurnFor / handleTurnEvent / readTurnStream).
// tst_concurrentstreams.qml covers how independent turns coexist; this file
// pins what one turn's terminal paths — done, error, EOF, watchdog, cancel —
// must settle.
TestCase {
    name: "GhostdStream"

    function init(): void {
        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.clearTurnProjection();
        Ghostd.lastError = "";
        Ghostd.reachable = true;
        Ghostd.hudVisible = false;
    }

    function cleanup(): void {
        for (const key of Ghostd.liveConversationKeys.slice()) {
            const state = Ghostd.turnStates[key];
            if (state) Ghostd.cancelTurn(state);
        }
        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.currentSessionId = "";
        Ghostd.clearTurnProjection();
    }

    function openTurn(id: string, abortCounter: var): var {
        const publicId = "pi:" + id;
        Ghostd.adoptConversation("casper", publicId);
        const state = Ghostd.ensureTurnState("casper", publicId, id, "pi");
        Ghostd.beginTurnFor(state);
        Ghostd.appendTurnRow(state, {
            role: "user", text: "Start", toolActivity: [],
            error: "", pending: false, entryId: ""
        });
        Ghostd.appendTurnRow(state, {
            role: "assistant", text: "", toolActivity: [],
            error: "", pending: true, entryId: ""
        });
        state.assistantRow = state.rows.length - 1;
        const xhr = {
            readyState: 3,
            status: 200,
            responseText: "",
            abort: function () { if (abortCounter) abortCounter.count += 1; }
        };
        state.request = xhr;
        Ghostd.projectTurnFields(state);
        return { state: state, xhr: xhr };
    }

    function makeInteractionDirty(state: var): void {
        state.activity = "read";
        state.pendingAsk = ({ id: "ask-1" });
        state.askSubmitting = true;
        state.askError = "old ask error";
        state.steeringQueue = ["steer"];
        state.followUpQueue = ["later"];
        state.queueSubmitting = true;
        state.queueError = "old queue error";
        Ghostd.projectTurnFields(state);
    }

    function verifyInteractionSettled(state: var): void {
        verify(!state.streaming);
        compare(state.activity, "");
        compare(state.pendingAsk, null);
        verify(!state.askSubmitting);
        compare(state.askError, "");
        compare(state.steeringQueue.length, 0);
        compare(state.followUpQueue.length, 0);
        verify(!state.queueSubmitting);
        compare(state.queueError, "");
    }

    function test_restoredToolCardCarriesTheNarrationThatAnnouncedIt(): void {
        const tools = Ghostd.messageTools({ content: [
            { type: "text", text: "Checking your Dropbox for the invoice." },
            { type: "toolCall", id: "t1", name: "read", arguments: { path: "inv.pdf" } },
            { type: "text", text: "It is dated the 14th." }
        ] });
        compare(tools.length, 1);
        compare(tools[0].intent, "Checking your Dropbox for the invoice.");
    }

    function test_dequeuedSteerBecomesTranscriptRowWithoutReload(): void {
        const turn = openTurn("steer", null);
        turn.state.steeringQueue = ["Use the shorter version."];
        Ghostd.handleTurnEvent(turn.state,
            { type: "text_end", contentIndex: 0, content: "First pass" });
        Ghostd.handleTurnEvent(turn.state,
            { type: "owner_message", text: "Use the shorter version." });

        compare(turn.state.rows.length, 4);
        compare(turn.state.rows[1].text, "First pass");
        verify(!turn.state.rows[1].pending);
        compare(turn.state.rows[2].role, "user");
        compare(turn.state.rows[2].text, "Use the shorter version.");
        compare(turn.state.rows[3].role, "assistant");
        verify(turn.state.rows[3].pending);
        compare(turn.state.steeringQueue.length, 0);
        verify(turn.state.streaming);
        // The active projection mirrors the rows without a transcript reload.
        compare(Ghostd.transcript.count, 4);
        compare(Ghostd.transcript.get(2).text, "Use the shorter version.");
    }

    function test_consecutiveSteersDoNotCreateEmptyAssistantRows(): void {
        const turn = openTurn("steer-batch", null);

        Ghostd.handleTurnEvent(turn.state, { type: "owner_message", text: "First steer" });
        Ghostd.handleTurnEvent(turn.state, { type: "owner_message", text: "Second steer" });

        compare(turn.state.rows.length, 4);
        compare(turn.state.rows[0].role, "user");
        compare(turn.state.rows[1].text, "First steer");
        compare(turn.state.rows[2].text, "Second steer");
        compare(turn.state.rows[3].role, "assistant");
        verify(turn.state.rows[3].pending);
    }

    function test_eofWithoutTerminalSettlesEveryTurnField(): void {
        const turn = openTurn("eof", null);
        makeInteractionDirty(turn.state);
        turn.xhr.readyState = 4;
        turn.xhr.responseText = "data: {\"type\":\"start\"}\n\n";

        Ghostd.readTurnStream(turn.xhr, turn.state.key, "turn", "missing terminal");

        verifyInteractionSettled(turn.state);
        compare(turn.state.lastError, "missing terminal");
        verify(!turn.state.rows[1].pending);
        compare(turn.state.request, null);
    }

    function test_doneAndErrorBothSettleEveryTurnField(): void {
        for (const terminal of [
            { type: "done", expected: "" },
            { type: "error", errorMessage: "provider failed", expected: "provider failed" }
        ]) {
            const turn = openTurn("terminal-" + terminal.type, null);
            makeInteractionDirty(turn.state);
            Ghostd.handleTurnEvent(turn.state, terminal);

            verifyInteractionSettled(turn.state);
            compare(turn.state.lastError, terminal.expected);
            verify(!turn.state.rows[turn.state.rows.length - 1].pending);
        }
    }

    function test_limitReachedNamesTheWindowInsteadOfAGenericFailure(): void {
        const turn = openTurn("limit", null);
        Ghostd.handleTurnEvent(turn.state, {
            type: "limit_reached", harness: "claude-code", kind: "usage_limit",
            window: "seven_day", resetsAt: "2026-09-17T17:00:00Z",
            message: "Claude Code seven_day limit reached."
        });
        compare(turn.state.activity, "limit reached");
        Ghostd.handleTurnEvent(turn.state, { type: "error", errorMessage: "Claude Code ended with error_during_execution." });
        verify(turn.state.lastError.indexOf("Claude Code usage limit (seven day) reached") === 0, turn.state.lastError);
        verify(turn.state.lastError.indexOf("resets") > 0, turn.state.lastError);
        // The next turn starts without the stale notice.
        const next = openTurn("after-limit", null);
        compare(next.state.limitNotice, "");
    }

    function test_reanswerBranchUsesTheSameTerminalCleanup(): void {
        const publicId = "pi:reanswer";
        Ghostd.adoptConversation("casper", publicId);
        const state = Ghostd.ensureTurnState("casper", publicId, "reanswer", "pi");
        Ghostd.beginTurnFor(state);
        Ghostd.handleTurnEvent(state, {
            type: "branch_changed",
            transcript: {
                id: publicId,
                conversationId: "reanswer",
                runtime: "pi",
                messages: [{ role: "user", content: "Earlier question", entryId: "entry-1" }]
            }
        });
        makeInteractionDirty(state);
        Ghostd.handleTurnEvent(state, { type: "done" });

        verifyInteractionSettled(state);
        compare(state.rows[0].text, "Earlier question");
        verify(!state.rows[1].pending);
    }

    function test_watchdogSettlesAndRetiresThePartialStream(): void {
        const aborts = { count: 0 };
        const turn = openTurn("watchdog", aborts);
        makeInteractionDirty(turn.state);

        Ghostd.expireTurnStream(turn.state);

        compare(aborts.count, 1);
        compare(turn.state.request, null);
        verify(!Ghostd.reachable);
        compare(turn.state.lastError, "the stream stopped responding");
        verifyInteractionSettled(turn.state);
    }

    function test_askExecutionEndClearsTimedOutDialogBeforeTurnEnds(): void {
        const turn = openTurn("ask-timeout", null);
        turn.state.pendingAsk = ({ id: "ask-timeout" });
        turn.state.askSubmitting = true;
        turn.state.askError = "old error";

        Ghostd.handleTurnEvent(turn.state, {
            type: "tool_execution_end",
            id: "call-ask",
            toolName: "ask",
            isError: false,
            summary: "Timed out"
        });

        compare(turn.state.pendingAsk, null);
        verify(!turn.state.askSubmitting);
        compare(turn.state.askError, "");
        verify(turn.state.streaming);
    }

    function test_toolExecutionCapturesTheCallCwd(): void {
        const turn = openTurn("tool-cwd", null);
        Ghostd.handleTurnEvent(turn.state, {
            type: "tool_execution_start",
            id: "call-write",
            toolName: "write",
            arguments: { path: "notes.md" },
            cwd: "/home/owner/project-a"
        });

        const tools = turn.state.rows[1].toolActivity;
        compare(tools.length, 1);
        compare(tools[0].cwd, "/home/owner/project-a");
    }

    function test_restoredToolKeepsItsOwnCwd(): void {
        const tools = Ghostd.messageTools({
            content: [{
                type: "toolCall",
                id: "history-write",
                name: "write",
                arguments: { path: "notes.md" },
                cwd: "/home/owner/project-before-cd"
            }]
        });

        compare(tools.length, 1);
        compare(tools[0].cwd, "/home/owner/project-before-cd");
        compare(Ghostd.messageTools({
            content: [{ type: "toolCall", name: "write", arguments: { path: "old.md" } }]
        })[0].cwd, "");
    }

    function test_cancelRetiresXhrBeforeItsSynchronousAbortCallback(): void {
        const turn = openTurn("cancel", null);
        const state = turn.state;
        let aborts = 0;
        const xhr = {
            readyState: 3,
            status: 0,
            responseText: "",
            abort: function () {
                aborts += 1;
                Ghostd.readTurnStream(xhr, state.key, "turn", "missing terminal");
            }
        };
        state.request = xhr;

        Ghostd.cancelTurn(state);

        compare(aborts, 1);
        verify(Ghostd.reachable);
        compare(state.lastError, "");
        verify(!state.streaming);
    }

    function test_clickingActiveTitleDoesNotInterruptItsTurn(): void {
        const aborts = { count: 0 };
        const turn = openTurn("active-click", aborts);

        Ghostd.openConversation(turn.state.sessionId);

        verify(turn.state.streaming);
        compare(turn.state.request, turn.xhr);
        compare(aborts.count, 0);
    }
}
