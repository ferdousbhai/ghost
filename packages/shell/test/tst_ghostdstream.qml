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
        Ghostd.adoptConversation("casper", id);
        const state = Ghostd.ensureTurnState("casper", id);
        Ghostd.beginTurnFor(state);
        Ghostd.appendTurnRow(state, {
            role: "user", text: "Start", toolActivity: [],
            error: "", pending: false
        });
        Ghostd.appendTurnRow(state, {
            role: "assistant", text: "", toolActivity: [],
            error: "", pending: true
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
        state.followUpQueue = ["later"];
        state.queueSubmitting = true;
        state.queueError = "old queue error";
        Ghostd.projectTurnFields(state);
    }

    function verifyInteractionSettled(state: var): void {
        verify(!state.streaming);
        compare(state.activity, "");
        compare(state.followUpQueue.length, 0);
        verify(!state.queueSubmitting);
        compare(state.queueError, "");
    }

    function test_dequeuedFollowUpBecomesTranscriptRowWithoutReload(): void {
        const turn = openTurn("follow-up", null);
        turn.state.followUpQueue = ["Use the shorter version."];
        Ghostd.handleTurnEvent(turn.state,
            { type: "text_end", contentIndex: 0, content: "First pass" });
        // The daemon announces the shorter queue, then the message it dequeued.
        Ghostd.handleTurnEvent(turn.state, { type: "queue", followUp: [] });
        Ghostd.handleTurnEvent(turn.state,
            { type: "owner_message", text: "Use the shorter version." });

        compare(turn.state.rows.length, 4);
        compare(turn.state.rows[1].text, "First pass");
        verify(!turn.state.rows[1].pending);
        compare(turn.state.rows[2].role, "user");
        compare(turn.state.rows[2].text, "Use the shorter version.");
        compare(turn.state.rows[3].role, "assistant");
        verify(turn.state.rows[3].pending);
        compare(turn.state.followUpQueue.length, 0);
        verify(turn.state.streaming);
        // The active projection mirrors the rows without a transcript reload.
        compare(Ghostd.transcript.count, 4);
        compare(Ghostd.transcript.get(2).text, "Use the shorter version.");
    }

    function test_aQueueEventReplacesTheChips(): void {
        const turn = openTurn("queued", null);
        Ghostd.handleTurnEvent(turn.state, { type: "queue", followUp: ["one", "two"] });
        compare(turn.state.followUpQueue, ["one", "two"]);
        Ghostd.handleTurnEvent(turn.state, { type: "queue", followUp: ["two"] });
        compare(turn.state.followUpQueue, ["two"]);
    }

    function test_sessionStopContinuedInsertsHookRowBetweenPasses(): void {
        const turn = openTurn("stop-hook", null);
        Ghostd.handleTurnEvent(turn.state,
            { type: "text_end", contentIndex: 0, content: "Ghost 0.4.0 ready." });
        Ghostd.handleTurnEvent(turn.state,
            { type: "session_stop_continued", reason: "Keep going." });

        compare(turn.state.rows.length, 4);
        compare(turn.state.rows[1].text, "Ghost 0.4.0 ready.");
        verify(!turn.state.rows[1].pending);
        compare(turn.state.rows[2].role, "hook");
        compare(turn.state.rows[2].text, "Keep going.");
        compare(turn.state.rows[3].role, "assistant");
        verify(turn.state.rows[3].pending);
        compare(Ghostd.transcript.get(2).role, "hook");
    }

    function test_consecutiveFollowUpsDoNotCreateEmptyAssistantRows(): void {
        const turn = openTurn("follow-up-batch", null);

        Ghostd.handleTurnEvent(turn.state, { type: "owner_message", text: "First follow-up" });
        Ghostd.handleTurnEvent(turn.state, { type: "owner_message", text: "Second follow-up" });

        compare(turn.state.rows.length, 4);
        compare(turn.state.rows[0].role, "user");
        compare(turn.state.rows[1].text, "First follow-up");
        compare(turn.state.rows[2].text, "Second follow-up");
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

    function test_limitReachedNamesTheLimitInsteadOfAGenericFailure(): void {
        const turn = openTurn("limit", null);
        Ghostd.handleTurnEvent(turn.state, {
            type: "limit_reached", harness: "claude", kind: "usage_limit",
            message: "claude usage limit reached."
        });
        compare(turn.state.activity, "limit reached");
        Ghostd.handleTurnEvent(turn.state, { type: "error", errorMessage: "the provider ended the turn." });
        compare(turn.state.lastError, "claude usage limit reached");
        // The next turn starts without the stale notice.
        const next = openTurn("after-limit", null);
        compare(next.state.limitNotice, "");
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

    // A stored call keeps no cwd, so a relative path is never resolved
    // against a directory the call may not have run in.
    function test_restoredToolHasNoCwd(): void {
        const tools = Ghostd.messageTools(
            [{ type: "toolCall", id: "history-write", name: "write", arguments: { path: "notes.md" } }]);
        compare(tools.length, 1);
        compare(tools[0].cwd, "");
    }

    function test_restoredFailedCallStaysFailed(): void {
        const tools = Ghostd.messageTools([
            { type: "toolCall", id: "a", name: "Bash", arguments: {}, failed: true },
            { type: "toolCall", id: "b", name: "Bash", arguments: {} }
        ]);
        compare(tools[0].status, "failed");
        compare(tools[1].status, "complete");
    }

    // Text after a tool call is the ghost's next message: the calls stay with
    // the text before them, and nothing the ghost said is replaced.
    function test_textAfterToolsIsASeparateMessage(): void {
        const turn = openTurn("tool-order", null);
        Ghostd.handleTurnEvent(turn.state, { type: "text_end", contentIndex: 0, content: "Checking." });
        Ghostd.handleTurnEvent(turn.state, {
            type: "tool_execution_start", id: "c1", toolName: "Read", arguments: { file_path: "/a" }
        });
        Ghostd.handleTurnEvent(turn.state, {
            type: "tool_execution_start", id: "c2", toolName: "Read", arguments: { file_path: "/b" }
        });
        Ghostd.handleTurnEvent(turn.state, { type: "text_end", contentIndex: 1, content: "Done." });
        // A late end for a call in the closed message makes no card here.
        Ghostd.handleTurnEvent(turn.state, { type: "tool_execution_end", id: "c2", isError: false });
        Ghostd.flushTurn(turn.state, true);

        compare(turn.state.rows.length, 3);
        compare(turn.state.rows[1].text, "Checking.");
        verify(!turn.state.rows[1].pending);
        compare(turn.state.rows[1].toolActivity.length, 2);
        compare(turn.state.rows[1].toolActivity[1].status, "complete");
        compare(turn.state.rows[2].text, "Done.");
        compare(turn.state.rows[2].toolActivity.length, 0);
    }

    function test_ownerCommandStreamsAsABashCard(): void {
        const turn = openTurn("owner-command", null);
        Ghostd.handleTurnEvent(turn.state, {
            type: "tool_execution_start", id: "cmd", toolName: "bash",
            arguments: { command: "ls" }, cwd: "/home/owner"
        });
        Ghostd.handleTurnEvent(turn.state, {
            type: "tool_execution_end", id: "cmd", toolName: "bash", isError: false, summary: "a b"
        });
        Ghostd.handleTurnEvent(turn.state, { type: "done" });

        compare(turn.state.lastError, "");
        compare(turn.state.rows[1].role, "assistant");
        compare(turn.state.rows[1].toolActivity[0].name, "bash");
        compare(turn.state.rows[1].toolActivity[0].status, "complete");
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
