import QtQuick
import QtTest
import qs.services

TestCase {
    name: "ConcurrentStreams"

    SignalSpy {
        id: finishedSpy
        target: Ghostd
        signalName: "turnFinished"
    }

    function init(): void {
        const previous = Ghostd.activeTurnState(false);
        if (previous && previous.streaming) Ghostd.cancelTurn(previous);
        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.clearTurnProjection();
        Ghostd.reachable = true;
        Ghostd.hudVisible = false;
        finishedSpy.clear();
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

    function openTurn(id: string, prompt: string, abortCounter: var): var {
        const publicId = "pi:" + id;
        Ghostd.adoptConversation("casper", publicId);
        const state = Ghostd.ensureTurnState("casper", publicId, id, "pi");
        Ghostd.beginTurnFor(state);
        Ghostd.appendTurnRow(state, {
            role: "user", text: prompt, tools: "", toolActivity: [],
            error: "", pending: false, entryId: ""
        });
        Ghostd.appendTurnRow(state, {
            role: "assistant", text: "", tools: "", toolActivity: [],
            error: "", pending: true, entryId: ""
        });
        state.assistantRow = state.rows.length - 1;
        const xhr = {
            readyState: 3,
            status: 200,
            responseText: "",
            abort: function () { abortCounter.count += 1; }
        };
        state.request = xhr;
        Ghostd.projectTurnFields(state);
        return { state: state, xhr: xhr };
    }

    function push(turn: var, event: var): void {
        turn.xhr.responseText += "data: " + JSON.stringify(event) + "\n\n";
        Ghostd.readTurnStream(turn.xhr, turn.state.key, "test turn", "missing terminal");
    }

    function test_twoConversationsStreamAndSettleIndependently(): void {
        const firstAborts = { count: 0 };
        const secondAborts = { count: 0 };
        const firstText = "First answer ".repeat(18);
        const secondText = "Second answer ".repeat(18);
        const first = openTurn("one", "First prompt", firstAborts);
        push(first, { type: "text_start", contentIndex: 0 });
        push(first, { type: "text_delta", contentIndex: 0, delta: firstText });

        const second = openTurn("two", "Second prompt", secondAborts);
        compare(firstAborts.count, 0);
        verify(first.state.streaming);
        verify(second.state.streaming);
        compare(Ghostd.liveConversationKeys.length, 2);

        push(second, { type: "text_start", contentIndex: 0 });
        push(second, { type: "text_delta", contentIndex: 0, delta: secondText });
        Ghostd.flushTurn(second.state, true, false);

        // A background chunk updates its own rows without changing the open
        // conversation's visible transcript.
        push(first, { type: "text_delta", contentIndex: 0, delta: " continues" });
        Ghostd.flushTurn(first.state, true, false);
        compare(Ghostd.currentSessionId, "pi:two");
        compare(Ghostd.transcript.get(1).text, secondText);

        Ghostd.adoptConversation("casper", "pi:one");
        compare(secondAborts.count, 0);
        compare(Ghostd.transcript.get(1).text, firstText + " continues");
        verify(Ghostd.streaming);

        push(second, { type: "done", reason: "stop" });
        verify(!second.state.streaming);
        verify(first.state.streaming);
        verify(Ghostd.streaming);
        compare(Ghostd.liveConversationKeys.length, 1);
        compare(finishedSpy.count, 1);

        // A duplicate terminal source (for example EOF racing the event) is a no-op.
        Ghostd.handleTurnEvent(second.state, { type: "done", reason: "stop" });
        compare(finishedSpy.count, 1);

        push(first, { type: "done", reason: "stop" });
        verify(!Ghostd.anyStreaming);
        verify(!Ghostd.streaming);
        compare(finishedSpy.count, 2);
        compare(firstAborts.count, 0);
        compare(secondAborts.count, 0);
    }

    function test_newLiveRowSurvivesRefetchAndDefersReadWrite(): void {
        const aborts = { count: 0 };
        const turn = openTurn("new-live", "New prompt", aborts);
        Ghostd.sessions = [];
        Ghostd.ensureOptimisticSessionRow("casper", "pi:new-live");

        compare(Ghostd.sessions.length, 1);
        verify(Ghostd.sessions[0].localOnly);
        compare(Ghostd.mergeSessionListing("casper", []).length, 1);

        const held = Object.keys(Ghostd.readSessionRequests).length;
        Ghostd.markConversationRead("casper", "pi:new-live");
        compare(Object.keys(Ghostd.readSessionRequests).length, held);

        Ghostd.cancelTurn(turn.state);
        compare(aborts.count, 1);
        compare(Ghostd.mergeSessionListing("casper", []).length, 0);
    }

    function test_equalRawIdsAcrossRuntimesKeepDistinctSelectionAndResumeIds(): void {
        const parsed = Ghostd.parseConversationActionId("pi:inferred");
        verify(parsed !== null);
        compare(parsed.conversationId, "inferred");
        const inferred = Ghostd.ensureTurnState("casper", "pi:inferred");
        verify(inferred !== null);
        compare(inferred.conversationId, "inferred");
        const pi = Ghostd.ensureTurnState(
            "casper", "pi:default", "default", "pi");
        const claude = Ghostd.ensureTurnState(
            "casper", "claude-code:default", "default", "claude-code");
        verify(pi !== claude);
        verify(pi.key !== claude.key);
        compare(pi.conversationId, "default");
        compare(claude.conversationId, "default");
        compare(Ghostd.validSessionRows([
            { id: "pi:default", conversationId: "default", runtime: "pi" },
            {
                id: "claude-code:default", conversationId: "default",
                runtime: "claude-code"
            }
        ]).length, 2);

        Ghostd.appendTurnRow(pi, {
            role: "assistant", text: "Pi history", tools: "", toolActivity: [],
            error: "", pending: false, entryId: "pi-entry"
        });
        Ghostd.appendTurnRow(claude, {
            role: "assistant", text: "Claude history", tools: "", toolActivity: [],
            error: "", pending: false, entryId: "claude-entry"
        });

        Ghostd.adoptConversation("casper", pi.sessionId);
        compare(Ghostd.currentSessionId, "pi:default");
        compare(Ghostd.transcript.get(0).text, "Pi history");
        compare(Ghostd.buildBody("casper", "continue", pi).options.sessionId, "default");

        Ghostd.adoptConversation("casper", claude.sessionId);
        compare(Ghostd.currentSessionId, "claude-code:default");
        compare(Ghostd.transcript.get(0).text, "Claude history");
        compare(Ghostd.buildBody("casper", "continue", claude).options.sessionId, "default");

        Ghostd.adoptConversationRuntime("casper", "pi");
        compare(Ghostd.currentSessionId, "pi:default");
        compare(Ghostd.transcript.get(0).text, "Pi history");
    }

    function test_staleModelResponsesCannotUndoRuntimeOrCrossGhosts(): void {
        Ghostd.sessions = [
            { id: "pi:default", conversationId: "default", runtime: "pi" },
            {
                id: "claude-code:default", conversationId: "default",
                runtime: "claude-code"
            }
        ];
        Ghostd.ensureTurnState("casper", "pi:default", "default", "pi");
        Ghostd.ensureTurnState(
            "casper", "claude-code:default", "default", "claude-code");
        Ghostd.adoptConversation("casper", "pi:default");
        Ghostd.currentModel = { provider: "openai-codex", id: "old" };

        const beforePutGeneration = Ghostd.modelGeneration;
        const beforePut = {
            readyState: 4,
            status: 200,
            responseText: JSON.stringify({
                current: { provider: "openai-codex", id: "old" },
                source: "role"
            })
        };
        Ghostd.modelRequest = beforePut;
        verify(Ghostd.adoptSelectedModelRuntime("casper", "claude-code"));
        compare(Ghostd.currentSessionId, "claude-code:default");

        // Even if the old request is delivered after the PUT callback, its
        // captured generation cannot restore Pi or overwrite the model view.
        Ghostd.modelRequest = beforePut;
        verify(!Ghostd.applyCurrentModelResponse(
            beforePut, "casper", beforePutGeneration));
        compare(Ghostd.currentSessionId, "claude-code:default");
        compare(Ghostd.currentModel.id, "old");

        const afterPutGeneration = Ghostd.modelGeneration;
        const fresh = {
            readyState: 4,
            status: 200,
            responseText: JSON.stringify({
                current: { provider: "claude-code", id: "default" },
                source: "role"
            })
        };
        const superseded = {
            readyState: 4,
            status: 200,
            responseText: beforePut.responseText
        };
        Ghostd.modelRequest = fresh;
        verify(!Ghostd.applyCurrentModelResponse(
            superseded, "casper", afterPutGeneration));
        verify(Ghostd.applyCurrentModelResponse(
            fresh, "casper", afterPutGeneration));
        compare(Ghostd.currentModel.provider, "claude-code");
        compare(Ghostd.currentSessionId, "claude-code:default");

        const oldGhost = {
            readyState: 4,
            status: 200,
            responseText: beforePut.responseText
        };
        const oldGhostGeneration = Ghostd.modelGeneration;
        Ghostd.modelRequest = oldGhost;
        Ghostd.activeGhost = "mina";
        Ghostd.modelRequest = oldGhost;
        verify(!Ghostd.applyCurrentModelResponse(
            oldGhost, "casper", oldGhostGeneration));
        compare(Ghostd.currentModel.provider, "claude-code");
    }
}
