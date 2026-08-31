import QtQuick
import QtTest
import qs.services

TestCase {
    id: tc
    name: "GhostdStream"
    property var stopRequests: []

    function fakeStopRequest(): var {
        const xhr = {
            readyState: 0, status: 0, responseText: "", onreadystatechange: null,
            open: function () { this.readyState = 1; },
            setRequestHeader: function () {},
            send: function () {},
            abort: function () { this.readyState = 4; },
            complete: function (status, body) {
                this.status = status;
                this.responseText = JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        tc.stopRequests.push(xhr);
        return xhr;
    }

    function init(): void {
        const previous = Ghostd.activeTurnState(false);
        if (previous && previous.streaming) Ghostd.cancelTurn(previous);
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "pi:stream-test";
        Ghostd.sessionIds = ({ casper: "pi:stream-test" });
        Ghostd.clearTranscript();
        Ghostd.lastError = "";
        Ghostd.reachable = true;
        stopRequests = [];
        Ghostd.stopRequestFactory = function () { return tc.fakeStopRequest(); };
    }

    function cleanup(): void {
        const state = Ghostd.activeTurnState(false);
        if (state && state.streaming) Ghostd.cancelTurn(state);
        Ghostd.stopRequestFactory = null;
        Ghostd.clearTranscript();
    }

    function openTurn(): void {
        Ghostd.beginTurn();
        Ghostd.transcript.append({
            role: "user", text: "Start", tools: "", toolActivity: [],
            error: "", pending: false, entryId: ""
        });
        Ghostd.transcript.append({
            role: "assistant", text: "", tools: "", toolActivity: [],
            error: "", pending: true, entryId: ""
        });
        Ghostd.assistantRow = 1;
    }

    function makeInteractionDirty(): void {
        Ghostd.activity = "read";
        Ghostd.statusText = "Still reading";
        Ghostd.pendingAsk = ({ id: "ask-1" });
        Ghostd.askSubmitting = true;
        Ghostd.askError = "old ask error";
    }

    function verifyInteractionSettled(): void {
        verify(!Ghostd.streaming);
        compare(Ghostd.activity, "");
        compare(Ghostd.statusText, "");
        compare(Ghostd.pendingAsk, null);
        verify(!Ghostd.askSubmitting);
        compare(Ghostd.askError, "");
    }

    function test_ownerAttributedPassBecomesTranscriptRowWithoutReload(): void {
        openTurn();
        Ghostd.handleEvent({ type: "text_end", contentIndex: 0, content: "First pass" });
        Ghostd.handleEvent({ type: "owner_message", text: "Use the shorter version." });

        compare(Ghostd.transcript.count, 4);
        compare(Ghostd.transcript.get(1).text, "First pass");
        verify(!Ghostd.transcript.get(1).pending);
        compare(Ghostd.transcript.get(2).role, "user");
        compare(Ghostd.transcript.get(2).text, "Use the shorter version.");
        compare(Ghostd.transcript.get(3).role, "assistant");
        verify(Ghostd.transcript.get(3).pending);
        verify(Ghostd.streaming);
    }

    function test_consecutiveOwnerPassesDoNotCreateEmptyAssistantRows(): void {
        openTurn();

        Ghostd.handleEvent({ type: "owner_message", text: "First owner pass" });
        Ghostd.handleEvent({ type: "owner_message", text: "Second owner pass" });

        compare(Ghostd.transcript.count, 4);
        compare(Ghostd.transcript.get(0).role, "user");
        compare(Ghostd.transcript.get(1).text, "First owner pass");
        compare(Ghostd.transcript.get(2).text, "Second owner pass");
        compare(Ghostd.transcript.get(3).role, "assistant");
        verify(Ghostd.transcript.get(3).pending);
    }

    function test_stopKeepsTurnLiveUntilGhostdAcknowledgesRelease(): void {
        openTurn();

        Ghostd.cancel();
        compare(stopRequests.length, 1);
        verify(Ghostd.streaming);
        verify(Ghostd.stopSubmitting);

        stopRequests[0].complete(500, {
            error: { code: "internal_error", message: "stop failed" }
        });
        verify(Ghostd.streaming);
        verify(!Ghostd.stopSubmitting);
        verify(Ghostd.stopError.indexOf("stop failed") >= 0);
        compare(Ghostd.activeTurnState(false).stopRequest, null);

        Ghostd.cancel();
        compare(stopRequests.length, 2);
        stopRequests[1].complete(200, { stopped: true });
        verify(!Ghostd.streaming);
        verify(!Ghostd.stopSubmitting);
        compare(Ghostd.stopError, "");
        compare(Ghostd.activeTurnState(false).stopRequest, null);
    }

    function test_eofWithoutTerminalSettlesEveryTurnField(): void {
        openTurn();
        makeInteractionDirty();
        const xhr = { readyState: 4, status: 200, responseText: "data: {\"type\":\"start\"}\n\n" };
        Ghostd.request = xhr;
        Ghostd.currentSessionId = "";

        Ghostd.readStream(xhr, "casper", "turn", "missing terminal");

        verifyInteractionSettled();
        compare(Ghostd.lastError, "missing terminal");
        verify(!Ghostd.transcript.get(1).pending);
    }

    function test_doneAndErrorBothSettleEveryTurnField(): void {
        for (const terminal of [
            { type: "done", expected: "" },
            { type: "error", errorMessage: "provider failed", expected: "provider failed" }
        ]) {
            openTurn();
            makeInteractionDirty();
            Ghostd.currentSessionId = "";
            Ghostd.handleEvent(terminal);

            verifyInteractionSettled();
            compare(Ghostd.lastError, terminal.expected);
            verify(!Ghostd.transcript.get(Ghostd.transcript.count - 1).pending);
            Ghostd.clearTranscript();
        }
    }

    function test_reanswerBranchUsesTheSameTerminalCleanup(): void {
        Ghostd.beginTurn();
        Ghostd.handleEvent({
            type: "branch_changed",
            transcript: {
                id: "pi:stream-test",
                conversationId: "stream-test",
                runtime: "pi",
                messages: [{ role: "user", content: "Earlier question", entryId: "entry-1" }]
            }
        });
        makeInteractionDirty();
        Ghostd.currentSessionId = "";
        Ghostd.handleEvent({ type: "done" });

        verifyInteractionSettled();
        compare(Ghostd.transcript.get(0).text, "Earlier question");
        verify(!Ghostd.transcript.get(1).pending);
    }

    function test_watchdogSettlesAndRetiresThePartialStream(): void {
        openTurn();
        makeInteractionDirty();
        let aborts = 0;
        const xhr = {
            readyState: 3,
            status: 200,
            responseText: "",
            abort: function () { aborts += 1; }
        };
        Ghostd.request = xhr;
        Ghostd.currentSessionId = "";

        Ghostd.expireStream();

        compare(aborts, 1);
        compare(Ghostd.request, null);
        verify(!Ghostd.reachable);
        compare(Ghostd.lastError, "the stream stopped responding");
        verifyInteractionSettled();
    }

    function test_askExecutionEndClearsTimedOutDialogBeforeTurnEnds(): void {
        openTurn();
        Ghostd.pendingAsk = ({ id: "ask-timeout" });
        Ghostd.askSubmitting = true;
        Ghostd.askError = "old error";

        Ghostd.handleEvent({
            type: "tool_execution_end",
            id: "call-ask",
            toolName: "ask",
            isError: false,
            summary: "Timed out"
        });

        compare(Ghostd.pendingAsk, null);
        verify(!Ghostd.askSubmitting);
        compare(Ghostd.askError, "");
        verify(Ghostd.streaming);
    }

    function test_toolExecutionCapturesTheCallCwd(): void {
        openTurn();
        Ghostd.handleEvent({
            type: "tool_execution_start",
            id: "call-write",
            toolName: "write",
            arguments: { path: "notes.md" },
            cwd: "/home/owner/project-a"
        });

        const tools = Ghostd.transcript.get(1).toolActivity;
        compare(tools.count, 1);
        compare(tools.get(0).cwd, "/home/owner/project-a");
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
        openTurn();
        let aborts = 0;
        const xhr = {
            readyState: 3,
            status: 0,
            responseText: "",
            abort: function () {
                aborts += 1;
                Ghostd.readStream(xhr, "casper", "turn", "missing terminal");
            }
        };
        Ghostd.request = xhr;
        const state = Ghostd.activeTurnState(false);
        Ghostd.captureActiveTurn(state);

        Ghostd.cancelTurn(state);

        compare(aborts, 1);
        verify(Ghostd.reachable);
        compare(Ghostd.lastError, "");
        verify(!Ghostd.streaming);
    }

    function test_clickingActiveTitleDoesNotInterruptItsTurn(): void {
        openTurn();
        let aborts = 0;
        const xhr = {
            readyState: 3,
            status: 200,
            responseText: "",
            abort: function () { aborts += 1; }
        };
        Ghostd.request = xhr;

        Ghostd.openConversation("pi:stream-test");

        verify(Ghostd.streaming);
        compare(Ghostd.request, xhr);
        compare(aborts, 0);
    }
}
