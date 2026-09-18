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

    SignalSpy { id: failedSpy; target: Ghostd; signalName: "turnFailed" }
    SignalSpy { id: askSpy; target: Ghostd; signalName: "askWaiting" }

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
        failedSpy.clear();
        askSpy.clear();
        Ghostd.sessions = [];
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

    function test_newConversationReusesTheEmptyDraft(): void {
        Ghostd.newConversation();
        const first = Ghostd.currentSessionId;
        verify(first !== "");
        compare(Ghostd.sessions.length, 1);
        compare(Ghostd.sessions[0].id, first);
        compare(Ghostd.sessions[0].messageCount, 0);
        verify(Ghostd.sessions[0].localOnly);

        Ghostd.newConversation();
        compare(Ghostd.currentSessionId, first);
        compare(Ghostd.sessions.length, 1);
        compare(Ghostd.sessions[0].id, first);
    }

    function test_unstartedDraftSurvivesRefetch(): void {
        Ghostd.newConversation();
        const id = Ghostd.currentSessionId;
        const merged = Ghostd.mergeSessionListing("casper", []);
        compare(merged.length, 1);
        compare(merged[0].id, id);
        compare(merged[0].messageCount, 0);
    }

    function test_listingCollapsesExtraUnstartedRows(): void {
        const now = new Date().toISOString();
        Ghostd.currentSessionId = "pi:keep";
        const visible = Ghostd.orderSessions([
            {
                id: "pi:old", conversationId: "old", runtime: "pi",
                title: null, messageCount: 0, updatedAt: now, createdAt: now,
                pinned: false, localOnly: true
            },
            {
                id: "pi:keep", conversationId: "keep", runtime: "pi",
                title: null, messageCount: 0, updatedAt: now, createdAt: now,
                pinned: false, localOnly: true
            },
            {
                id: "pi:fork", conversationId: "fork", runtime: "pi",
                title: null, messageCount: 0, updatedAt: now, createdAt: now,
                pinned: false
            },
            {
                id: "pi:named", conversationId: "named", runtime: "pi",
                title: "Weekend", messageCount: 2, updatedAt: now, createdAt: now,
                pinned: false
            }
        ]);
        compare(visible.length, 3);
        compare(visible.filter(function (session) { return session.id === "pi:keep"; }).length, 1);
        compare(visible.filter(function (session) { return session.id === "pi:named"; }).length, 1);
        compare(visible.filter(function (session) { return session.id === "pi:fork"; }).length, 1);
        compare(visible.filter(function (session) { return session.id === "pi:old"; }).length, 0);
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

    function test_backgroundCompletionCarriesConversationAndTitle(): void {
        const first = openTurn("one", "Fix login", { count: 0 });
        Ghostd.sessions = [{ id: "pi:one", title: "Login redirect" }];
        openTurn("two", "Other work", { count: 0 });
        push(first, { type: "text_end", contentIndex: 0, content: "Fixed. Tests pass." });
        push(first, { type: "done", reason: "stop" });
        compare(Array.from(finishedSpy.signalArguments[0]), ["casper", "Fixed. Tests pass.", "pi:one", "Login redirect"]);
    }

    function test_remoteCancellationDoesNotAnnounceSuccessOrFailure(): void {
        const turn = openTurn("cancel", "Cancel me", { count: 0 });
        push(turn, { type: "error", reason: "aborted", errorMessage: "Aborted" });
        verify(!turn.state.streaming);
        compare(finishedSpy.count, 0);
        compare(failedSpy.count, 0);
    }

    function test_backgroundAskNotifiesOnceAcrossPollingAndNavigation(): void {
        const first = openTurn("one", "First prompt", { count: 0 });
        openTurn("two", "Second prompt", { count: 0 });
        const ask = { id: "ask-one", questions: [{ question: "Keep sessions?" }] };
        Ghostd.receivePendingAskFor(first.state, ask);
        Ghostd.receivePendingAskFor(first.state, ask);
        compare(askSpy.count, 1);
        compare(Array.from(askSpy.signalArguments[0]), ["casper", ask, "pi:one", "First prompt"]);
        Ghostd.adoptConversation("casper", "pi:one");
        Ghostd.receivePendingAskFor(first.state, ask);
        compare(askSpy.count, 1);
        Ghostd.receivePendingAskFor(first.state, null);
        Ghostd.receivePendingAskFor(first.state, { id: "ask-two" });
        compare(askSpy.count, 2);
    }

    function test_emptyConversationDoesNotCachePlaceholderTitle(): void {
        Ghostd.adoptConversation("casper", "pi:new");
        const state = Ghostd.ensureTurnState("casper", "pi:new", "new", "pi");
        Ghostd.captureActiveTurn(state);
        state.rows.push({ role: "user", text: "Fix login redirect" });
        compare(Ghostd.notificationTitle(state), "Fix login redirect");
    }
}
