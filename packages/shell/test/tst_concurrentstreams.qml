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
        Ghostd.adoptConversation("casper", id);
        const state = Ghostd.ensureTurnState("casper", id);
        Ghostd.beginTurnFor(state);
        Ghostd.appendTurnRow(state, {
            role: "user", text: prompt, toolActivity: [],
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
        compare(Ghostd.currentSessionId, "two");
        compare(Ghostd.transcript.get(1).text, secondText);

        Ghostd.adoptConversation("casper", "one");
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

    // fail()'s daemon error belongs to the HUD, not to the conversation that
    // happened to be open: it is never saved into one, and opening a
    // conversation with no state of its own leaves it standing.
    function test_aDaemonErrorIsNotSavedIntoTheOpenConversation(): void {
        const down = "ghostd is not answering on http://127.0.0.1:0";
        const state = Ghostd.ensureTurnState("casper", "a");
        Ghostd.currentSessionId = "a";
        Ghostd.showTurnState("casper", "a");
        Ghostd.lastError = down;

        Ghostd.captureActiveTurn(state);
        compare(state.lastError, "");

        Ghostd.currentSessionId = "";
        Ghostd.showTurnState("casper", "");
        compare(Ghostd.lastError, down);
        Ghostd.lastError = "";
    }

    function test_newLiveRowSurvivesRefetchAndDefersReadWrite(): void {
        const aborts = { count: 0 };
        const turn = openTurn("new-live", "New prompt", aborts);
        Ghostd.sessions = [];
        Ghostd.ensureLocalSessionRow("casper", "new-live", 1);

        compare(Ghostd.sessions.length, 1);
        verify(Ghostd.sessions[0].localOnly);
        compare(Ghostd.mergeSessionListing("casper", []).length, 1);

        const held = Object.keys(Ghostd.readSessionRequests).length;
        Ghostd.markConversationRead("casper", "new-live");
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
        Ghostd.currentSessionId = "keep";
        const visible = Ghostd.orderSessions([
            {
                id: "old", title: null, messageCount: 0, updatedAt: now, createdAt: now,
                pinned: false, localOnly: true
            },
            {
                id: "keep", title: null, messageCount: 0, updatedAt: now, createdAt: now,
                pinned: false, localOnly: true
            },
            {
                id: "listed-empty", title: null, messageCount: 0, updatedAt: now, createdAt: now,
                pinned: false
            },
            {
                id: "named", title: "Weekend", messageCount: 2, updatedAt: now, createdAt: now,
                pinned: false
            }
        ]);
        compare(visible.length, 3);
        compare(visible.filter(function (session) { return session.id === "keep"; }).length, 1);
        compare(visible.filter(function (session) { return session.id === "named"; }).length, 1);
        compare(visible.filter(function (session) { return session.id === "listed-empty"; }).length, 1);
        compare(visible.filter(function (session) { return session.id === "old"; }).length, 0);
    }

    function test_conversationIdsAreSentBareAndValidated(): void {
        const first = Ghostd.ensureTurnState("casper", "hud-abc");
        const second = Ghostd.ensureTurnState("casper", "other");
        verify(first !== second);
        compare(Ghostd.buildBody("continue", first).options.sessionId, "hud-abc");
        verify(!("model" in Ghostd.buildBody("continue", first)));
        compare(Ghostd.ensureTurnState("casper", ".hidden"), null);
        compare(Ghostd.ensureTurnState("casper", "pi:old"), null);
        compare(Ghostd.validSessionRows([{ id: "a" }, { id: "../x" }, { id: "" }, {}]).length, 1);
        verify(Ghostd.validConversationId(Ghostd.mintConversationId()));
    }

    function test_currentHarnessFollowsTheOpenConversationRow(): void {
        Ghostd.sessions = [{ id: "a", harness: "claude" }, { id: "b", harness: null }];
        Ghostd.currentSessionId = "a";
        compare(Ghostd.currentHarness, "claude");
        Ghostd.currentSessionId = "b";
        compare(Ghostd.currentHarness, "");
        Ghostd.currentSessionId = "";
    }

    function test_backgroundCompletionCarriesConversationAndTitle(): void {
        const first = openTurn("one", "Fix login", { count: 0 });
        Ghostd.sessions = [{ id: "one", title: "Login redirect" }];
        openTurn("two", "Other work", { count: 0 });
        push(first, { type: "text_end", contentIndex: 0, content: "Fixed. Tests pass." });
        push(first, { type: "done", reason: "stop" });
        compare(Array.from(finishedSpy.signalArguments[0]), ["casper", "Fixed. Tests pass.", "one", "Login redirect"]);
    }

    function test_remoteCancellationDoesNotAnnounceSuccessOrFailure(): void {
        const turn = openTurn("cancel", "Cancel me", { count: 0 });
        push(turn, { type: "error", reason: "aborted", errorMessage: "Aborted" });
        verify(!turn.state.streaming);
        compare(finishedSpy.count, 0);
        compare(failedSpy.count, 0);
    }

    function test_emptyConversationDoesNotCachePlaceholderTitle(): void {
        Ghostd.adoptConversation("casper", "new");
        const state = Ghostd.ensureTurnState("casper", "new");
        Ghostd.captureActiveTurn(state);
        state.rows.push({ role: "user", text: "Fix login redirect" });
        compare(Ghostd.notificationTitle(state), "Fix login redirect");
    }
}
