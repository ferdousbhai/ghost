import QtQuick
import QtTest
import "../qml/services"

TestCase {
    id: tc
    name: "TranscriptPagination"

    property var requests: []
    property var deleteRequests: []
    property var branchRequests: []
    property string deleteSettlementError: ""

    Connections {
        target: Ghostd
        function onDeletingSessionIdChanged(): void {
            if (Ghostd.deletingSessionId === "")
                tc.deleteSettlementError = Ghostd.sessionsError;
        }
    }

    function fakeRequest(bucket: var): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            method: "",
            url: "",
            sent: false,
            aborted: false,
            headers: ({}),
            onreadystatechange: null,
            open: function (method, url) {
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
            send: function () { this.sent = true; },
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                this.status = 0;
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            }
        };
        bucket.push(xhr);
        return xhr;
    }

    function messages(first: int, count: int): var {
        const result = [];
        for (let index = first; index < first + count; index++) {
            result.push({
                role: "user",
                content: "message-" + index,
                entryId: "entry-" + index,
                parentId: index === 0 ? null : "entry-" + (index - 1)
            });
        }
        return result;
    }

    function page(state: var, rows: var, total: int, truncated: bool,
            historyTruncated: var): var {
        return {
            id: state.sessionId,
            conversationId: state.conversationId,
            runtime: state.runtime,
            title: null,
            messages: rows,
            total: total,
            truncated: truncated,
            historyTruncated: historyTruncated === true
        };
    }

    function activeState(id: string): var {
        const publicId = "pi:" + id;
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = publicId;
        Ghostd.sessionIds = ({ casper: publicId });
        const state = Ghostd.ensureTurnState("casper", publicId, id, "pi");
        Ghostd.showTurnState("casper", publicId);
        return state;
    }

    function init(): void {
        Ghostd.cancelAllTranscriptLoads();
        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.clearTurnProjection();
        Ghostd.sessionsError = "";
        Ghostd.modelError = "";
        Ghostd.apiToken = "test-token";
        Ghostd.availableModels = [];
        Ghostd.availableModelTotal = 0;
        requests = [];
        deleteRequests = [];
        branchRequests = [];
        deleteSettlementError = "";
        Ghostd.transcriptRequestFactory = function () {
            return fakeRequest(requests);
        };
        Ghostd.deleteSessionRequestFactory = function () {
            return fakeRequest(deleteRequests);
        };
        Ghostd.branchRequestFactory = function () {
            return fakeRequest(branchRequests);
        };
    }

    function cleanup(): void {
        Ghostd.cancelAllTranscriptLoads();
        Ghostd.transcriptRequestFactory = null;
        Ghostd.deleteSessionRequestFactory = null;
        Ghostd.branchRequestFactory = null;
        Ghostd.turnStates = ({});
        Ghostd.currentSessionId = "";
        Ghostd.clearTurnProjection();
    }

    function test_completeHistoryCrossesDefaultPageWithoutDuplicates(): void {
        const state = activeState("long");
        state.rows = [{
            role: "user", text: "old-visible-row", toolActivity: [],
            error: "", pending: false, entryId: "old"
        }];
        Ghostd.showTurnState("casper", state.sessionId);

        Ghostd.loadConversationTranscript(state, false);

        compare(requests.length, 1);
        verify(requests[0].url.endsWith("?limit=1000&offset=0"));
        compare(state.rows.length, 1); // pages are assembled off-screen
        requests[0].complete(200, page(state, messages(0, 1000), 1005, true));

        compare(requests.length, 2);
        verify(requests[1].url.endsWith("?limit=1000&offset=1000"));
        compare(state.rows.length, 1);
        requests[1].complete(200, page(state, messages(1000, 5), 1005, true));

        compare(state.rows.length, 1005);
        compare(Ghostd.transcript.count, 1005);
        compare(state.rows[0].text, "message-0");
        compare(state.rows[999].text, "message-999");
        compare(state.rows[1000].text, "message-1000");
        compare(state.rows[1004].text, "message-1004");
        const ids = new Set(state.rows.map(function (row) { return row.entryId; }));
        compare(ids.size, 1005);
        compare(Ghostd.sessionsError, "");
        verify(!Ghostd.transcriptHistoryTruncated);
    }

    function test_historyMarkerIsRequiredConsistentAndProjected(): void {
        const state = activeState("legacy-history");
        Ghostd.loadConversationTranscript(state, false);
        const missingMarker = page(state, [], 0, false, false);
        delete missingMarker.historyTruncated;
        requests[0].complete(200, missingMarker);
        compare(Ghostd.sessionsError, "ghostd sent an inconsistent transcript page");

        requests = [];
        Ghostd.sessionsError = "";
        Ghostd.loadConversationTranscript(state, false);
        requests[0].complete(200,
            page(state, messages(0, 1000), 1001, true, true));
        compare(requests.length, 2);
        requests[1].complete(200,
            page(state, messages(1000, 1), 1001, true, false));
        compare(state.rows.length, 0);
        compare(Ghostd.sessionsError, "ghostd sent an inconsistent transcript page");

        requests = [];
        Ghostd.sessionsError = "";
        Ghostd.loadConversationTranscript(state, false);
        requests[0].complete(200, page(state, [], 0, false, true));
        verify(state.historyTruncated);
        verify(Ghostd.transcriptHistoryTruncated);

        // Reloading a complete history clears the marker again.
        requests = [];
        Ghostd.loadConversationTranscript(state, false);
        requests[0].complete(200, page(state, [], 0, false, false));
        verify(!state.historyTruncated);
        verify(!Ghostd.transcriptHistoryTruncated);
    }

    function test_savedTextTruncationIsVisibleAfterRehydration(): void {
        const state = activeState("bounded");
        Ghostd.loadConversationTranscript(state, false);
        requests[0].complete(200, page(state, [{
            role: "user",
            content: "bounded text",
            contentTruncated: true,
            entryId: "bounded-owner"
        }], 1, false, false));

        compare(state.rows.length, 1);
        compare(state.rows[0].text,
            "bounded text\n\n*[Saved message truncated]*");
    }

    function test_deepBranchLoadsCompleteHistoryInsteadOfAdoptingInlinePage(): void {
        activeState("source");

        Ghostd.branchFrom("entry-1005");
        compare(branchRequests.length, 1);
        compare(branchRequests[0].method, "POST");
        verify(branchRequests[0].url.indexOf("/sessions/pi%3Asource/branch") >= 0);

        const branched = {
            sessionId: "pi:branched",
            conversationId: "branched",
            runtime: "pi"
        };
        branchRequests[0].complete(200, {
            id: branched.sessionId,
            conversationId: branched.conversationId,
            runtime: branched.runtime,
            sessionId: branched.conversationId,
            title: null,
            draft: "message-1005",
            // The branch POST uses the daemon's default limit and is therefore
            // not authoritative for a deep history.
            transcript: page(branched, messages(0, 1000), 1005, true)
        });

        compare(Ghostd.currentSessionId, branched.sessionId);
        compare(Ghostd.transcript.count, 0);
        compare(requests.length, 1);
        verify(requests[0].url.indexOf("/sessions/pi%3Abranched/transcript") >= 0);
        verify(requests[0].url.endsWith("?limit=1000&offset=0"));

        requests[0].complete(200,
            page(branched, messages(0, 1000), 1005, true));
        compare(requests.length, 2);
        compare(Ghostd.transcript.count, 0);
        verify(requests[1].url.endsWith("?limit=1000&offset=1000"));
        requests[1].complete(200,
            page(branched, messages(1000, 5), 1005, true));

        compare(Ghostd.transcript.count, 1005);
        compare(Ghostd.transcript.get(0).text, "message-0");
        compare(Ghostd.transcript.get(999).text, "message-999");
        compare(Ghostd.transcript.get(1000).text, "message-1000");
        compare(Ghostd.transcript.get(1004).text, "message-1004");
        compare(Ghostd.sessionsError, "");
        compare(Ghostd.branchError, "");
    }

    function test_emptyPageCompletesAndClearsOldRows(): void {
        const state = activeState("empty");
        state.rows = [{
            role: "assistant", text: "stale", toolActivity: [],
            error: "", pending: false, entryId: "stale"
        }];
        Ghostd.showTurnState("casper", state.sessionId);
        Ghostd.loadConversationTranscript(state, false);
        requests[0].complete(200, page(state, [], 0, false));

        compare(requests.length, 1);
        compare(state.rows.length, 0);
        compare(Ghostd.transcript.count, 0);
    }

    function test_open404IsAnHonestEmptyTranscript(): void {
        const state = activeState("not-started");
        state.rows = [{
            role: "user", text: "local placeholder", toolActivity: [],
            error: "", pending: false, entryId: "local"
        }];
        Ghostd.showTurnState("casper", state.sessionId);
        Ghostd.loadConversationTranscript(state, true);
        requests[0].complete(404, {
            error: { code: "not_found", message: "no such conversation" }
        });

        compare(requests.length, 1);
        compare(state.rows.length, 0);
        compare(Ghostd.transcript.count, 0);
        compare(Ghostd.sessionsError, "");
    }

    function test_shortPageContinuesButChangingTotalFailsUnpublished(): void {
        // A page shorter than the requested limit is the daemon's silent
        // clamp, not corruption: the load keeps paging from where it ended
        // and publishes nothing until the total is reached.
        const shortState = activeState("short");
        shortState.rows = [{
            role: "user", text: "known-good", toolActivity: [],
            error: "", pending: false, entryId: "known"
        }];
        Ghostd.showTurnState("casper", shortState.sessionId);
        Ghostd.loadConversationTranscript(shortState, false);
        requests[0].complete(200, page(shortState, messages(0, 2), 3, true));

        compare(requests.length, 2);
        verify(requests[1].url.endsWith("?limit=1000&offset=2"));
        compare(shortState.rows.length, 1);
        compare(shortState.rows[0].text, "known-good");
        requests[1].complete(200, page(shortState, messages(2, 1), 3, true));

        compare(shortState.rows.length, 3);
        compare(shortState.rows[2].text, "message-2");
        compare(Ghostd.sessionsError, "");

        requests = [];
        const changingState = activeState("changing");
        Ghostd.loadConversationTranscript(changingState, false);
        requests[0].complete(200,
            page(changingState, messages(0, 1000), 1001, true));
        compare(requests.length, 2);
        requests[1].complete(200,
            page(changingState, messages(1000, 2), 1002, true));

        compare(changingState.rows.length, 0);
        compare(Ghostd.sessionsError, "ghostd sent an inconsistent transcript page");
    }

    function test_totalBeyondPageBudgetStopsAtThePageCap(): void {
        // No total pre-check pins pageLimit × maxPages any more (a clamping
        // daemon would break it); the page-count guard is the single cap.
        const state = activeState("runaway");
        Ghostd.loadConversationTranscript(state, false);
        for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
            compare(requests.length, pageIndex + 1);
            requests[pageIndex].complete(200, page(state,
                messages(pageIndex * 1000, 1000), 10001, true));
        }

        compare(requests.length, 10);
        compare(state.rows.length, 0);
        compare(Ghostd.sessionsError, "Transcript is too large to load safely");
    }

    function test_exactTenThousandMessageBoundaryCompletes(): void {
        const state = activeState("cap-boundary");
        Ghostd.loadConversationTranscript(state, false);
        for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
            compare(requests.length, pageIndex + 1);
            requests[pageIndex].complete(200, page(state,
                messages(pageIndex * 1000, 1000), 10000, true));
        }

        compare(requests.length, 10);
        compare(state.rows.length, 10000);
        compare(state.rows[0].text, "message-0");
        compare(state.rows[9999].text, "message-9999");
        compare(Ghostd.sessionsError, "");
    }

    function test_repeatedPageRangeIsRejectedByPersistedEntryIdentity(): void {
        const state = activeState("repeat");
        Ghostd.loadConversationTranscript(state, false);
        const firstPage = messages(0, 1000);
        requests[0].complete(200, page(state, firstPage, 2000, true));
        compare(requests.length, 2);
        // A broken peer ignored offset=1000 and replayed page zero. Length and
        // truncation alone look plausible; persisted entry ids expose overlap.
        requests[1].complete(200, page(state, firstPage, 2000, true));

        compare(requests.length, 2);
        compare(state.rows.length, 0);
        compare(Ghostd.sessionsError, "ghostd sent an inconsistent transcript page");
    }

    function test_supersedeAndSessionSwitchAbortAndIgnoreLatePages(): void {
        const first = activeState("first");
        Ghostd.loadConversationTranscript(first, false);
        const stale = requests[0];
        Ghostd.loadConversationTranscript(first, false);
        const fresh = requests[1];

        verify(stale.aborted);
        stale.complete(200, page(first, messages(0, 1), 1, false));
        compare(first.rows.length, 0);
        fresh.complete(200, page(first, messages(10, 1), 1, false));
        compare(first.rows[0].text, "message-10");

        requests = [];
        Ghostd.loadConversationTranscript(first, false);
        const switched = requests[0];
        Ghostd.adoptConversation("casper", "pi:second");
        Ghostd.ensureTurnState("casper", "pi:second", "second", "pi");
        verify(switched.aborted);
        switched.complete(200, page(first, messages(20, 1), 1, false));
        compare(first.rows.length, 1);
        compare(first.rows[0].text, "message-10");
        compare(Ghostd.currentSessionId, "pi:second");
        compare(Ghostd.transcript.count, 0);
    }

    function test_ghostSwitchCancelsWithoutStalePollution(): void {
        const state = activeState("ghost-switch");
        Ghostd.loadConversationTranscript(state, false);
        const stale = requests[0];

        Ghostd.sessionIds.other = "";
        Ghostd.selectGhost("other");
        verify(stale.aborted);
        stale.complete(200, page(state, messages(0, 1), 1, false));

        compare(state.rows.length, 0);
        compare(Ghostd.activeGhost, "other");
        compare(Ghostd.transcript.count, 0);
        compare(Ghostd.sessionsError, "");
    }

    function test_newConversationCancelsAbandonedLoads(): void {
        const first = activeState("new-conversation");
        Ghostd.loadConversationTranscript(first, false);
        const abandonedNew = requests[0];
        Ghostd.reachable = false;
        Ghostd.newConversation();

        verify(abandonedNew.aborted);
        abandonedNew.complete(200,
            page(first, messages(0, 1000), 1001, true));
        compare(requests.length, 1);
        compare(first.rows.length, 0);
        verify(!Ghostd.reachable);
        verify(Ghostd.currentSessionId !== first.sessionId);
    }

    function test_deleteAndDestructionRetireEveryTranscriptOwner(): void {
        const deleted = activeState("deleted");
        Ghostd.sessions = [{
            id: deleted.sessionId,
            conversationId: deleted.conversationId,
            runtime: deleted.runtime,
            title: null
        }];
        Ghostd.loadConversationTranscript(deleted, false);
        const deletedLoad = requests[0];
        Ghostd.deleteConversation(deleted.sessionId);
        compare(deleteRequests.length, 1);
        deleteRequests[0].complete(200, { ok: true });

        verify(deletedLoad.aborted);
        Ghostd.reachable = false;
        deletedLoad.complete(200,
            page(deleted, messages(0, 1000), 1001, true));
        compare(requests.length, 1);
        verify(!Ghostd.turnStates[deleted.key]);
        verify(!Ghostd.reachable);

        requests = [];
        const active = activeState("destroy-active");
        const background = Ghostd.ensureTurnState(
            "casper", "pi:destroy-background", "destroy-background", "pi");
        Ghostd.loadConversationTranscript(active, false);
        Ghostd.loadConversationTranscript(background, false);
        const activeLoad = requests[0];
        const backgroundLoad = requests[1];
        Ghostd.retireClientRequests();

        verify(activeLoad.aborted);
        verify(backgroundLoad.aborted);
        Ghostd.reachable = false;
        activeLoad.complete(200, page(active, messages(0, 1), 1, false));
        backgroundLoad.complete(200, page(background, messages(1, 1), 1, false));
        compare(active.rows.length, 0);
        compare(background.rows.length, 0);
        verify(!Ghostd.reachable);
    }

    function test_httpFailureIsHonestAndKeepsKnownHistory(): void {
        const state = activeState("failure");
        state.rows = [{
            role: "user", text: "known history", toolActivity: [],
            error: "", pending: false, entryId: "known"
        }];
        Ghostd.showTurnState("casper", state.sessionId);
        Ghostd.loadConversationTranscript(state, false);
        requests[0].complete(503, JSON.stringify({
            error: { code: "busy", message: "try later" }
        }));

        compare(state.rows.length, 1);
        compare(state.rows[0].text, "known history");
        verify(Ghostd.sessionsError.indexOf("503") >= 0
            || Ghostd.sessionsError.indexOf("try later") >= 0);
    }

    // Lives here for the request-factory harness in init(); it is about page
    // accounting, not transcripts.

}
