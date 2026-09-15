import QtQuick
import QtTest
import "../qml/services"

TestCase {
    name: "ConcurrentStreams"

    SignalSpy {
        id: finishedSpy
        target: Ghostd
        signalName: "turnFinished"
    }

    function init(): void {
        Ghostd.cancel();
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
            role: "user", text: prompt, toolActivity: [],
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
        Ghostd.flushTurn(second.state, true);

        // A background chunk updates its own rows without changing the open
        // conversation's visible transcript.
        push(first, { type: "text_delta", contentIndex: 0, delta: " continues" });
        Ghostd.flushTurn(first.state, true);
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

    function test_qualifiedIdsKeepDistinctSelectionAndResumeIds(): void {
        const parsed = Ghostd.parseConversationActionId("pi:inferred");
        verify(parsed !== null);
        compare(parsed.conversationId, "inferred");
        const inferred = Ghostd.ensureTurnState("casper", "pi:inferred");
        verify(inferred !== null);
        compare(inferred.conversationId, "inferred");
        const first = Ghostd.ensureTurnState("casper", "pi:default", "default", "pi");
        const second = Ghostd.ensureTurnState("casper", "pi:other", "other", "pi");
        verify(first !== second);
        verify(first.key !== second.key);
        compare(first.conversationId, "default");
        compare(second.conversationId, "other");
        compare(Ghostd.validSessionRows([
            { id: "pi:default", conversationId: "default", runtime: "pi" },
            { id: "pi:other", conversationId: "other", runtime: "pi" }
        ]).length, 2);
        // An id the daemon can no longer mint is not a session row.
        compare(Ghostd.validSessionRows([
            { id: "claude-code:default", conversationId: "default", runtime: "claude-code" }
        ]).length, 0);

        Ghostd.appendTurnRow(first, {
            role: "assistant", text: "First history", toolActivity: [],
            error: "", pending: false, entryId: "first-entry"
        });
        Ghostd.appendTurnRow(second, {
            role: "assistant", text: "Second history", toolActivity: [],
            error: "", pending: false, entryId: "second-entry"
        });

        Ghostd.adoptConversation("casper", first.sessionId);
        compare(Ghostd.currentSessionId, "pi:default");
        compare(Ghostd.transcript.get(0).text, "First history");
        compare(Ghostd.buildBody("casper", "continue", first).options.sessionId, "default");

        Ghostd.adoptConversation("casper", second.sessionId);
        compare(Ghostd.currentSessionId, "pi:other");
        compare(Ghostd.transcript.get(0).text, "Second history");
        compare(Ghostd.buildBody("casper", "continue", second).options.sessionId, "other");
    }

    function test_staleModelResponsesCannotOverwriteOrCrossGhosts(): void {
        Ghostd.sessions = [
            { id: "pi:default", conversationId: "default", runtime: "pi" }
        ];
        Ghostd.ensureTurnState("casper", "pi:default", "default", "pi");
        Ghostd.adoptConversation("casper", "pi:default");
        Ghostd.currentModel = { provider: "openai-codex", id: "old" };

        const staleGeneration = Ghostd.modelGeneration;
        const stale = {
            readyState: 4,
            status: 200,
            responseText: JSON.stringify({
                current: { provider: "openai-codex", id: "old" },
                source: "role"
            })
        };
        // A newer selection bumps the generation; the in-flight read cannot
        // deliver its older view over it.
        Ghostd.modelGeneration += 1;
        const currentGeneration = Ghostd.modelGeneration;
        const fresh = {
            readyState: 4,
            status: 200,
            responseText: JSON.stringify({
                current: { provider: "openrouter", id: "free-tiny" },
                source: "role"
            })
        };
        Ghostd.modelRequest = fresh;
        verify(!Ghostd.applyCurrentModelResponse(stale, "casper", staleGeneration));
        verify(Ghostd.applyCurrentModelResponse(fresh, "casper", currentGeneration));
        compare(Ghostd.currentModel.provider, "openrouter");

        // A response for the ghost that is no longer active is dropped.
        const oldGhostGeneration = Ghostd.modelGeneration;
        Ghostd.modelRequest = stale;
        Ghostd.activeGhost = "mina";
        verify(!Ghostd.applyCurrentModelResponse(stale, "casper", oldGhostGeneration));
        compare(Ghostd.currentModel.provider, "openrouter");
    }
}
