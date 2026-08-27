import Quickshell
import QtQuick
import QtTest
import qs.services

TestCase {
    id: tc
    name: "HooksLifecycle"

    property var requests: []

    function fakeRequest(): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            method: "",
            url: "",
            body: null,
            aborted: false,
            headers: ({}),
            onreadystatechange: null,
            open: function (method, url) {
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
            send: function (body) { this.body = body; },
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                this.status = 0;
                if (this.onreadystatechange) this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        requests.push(xhr);
        return xhr;
    }

    function status(name: string): var {
        return {
            active: true,
            total: 2,
            events: [
                { event: "before_prompt", count: 1 },
                { event: "conversation_idle", count: 1 }
            ],
            hooks: [
                { event: "before_prompt", name, description: "Adds bounded context." },
                {
                    event: "conversation_idle",
                    name: "Memory upkeep",
                    description: "Runs after inactivity.",
                    idleSeconds: 60
                }
            ],
            sessionStopContinuationCap: 2
        };
    }

    function init(): void {
        requests = [];
        Ghostd.hooksRequestFactory = function () { return tc.fakeRequest(); };
        Ghostd.beginHooksConnectionEpoch();
        Ghostd.establishedConnection = false;
        Ghostd.reachable = false;
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({});
        Ghostd.apiToken = "test-token";
    }

    function cleanup(): void {
        Ghostd.retireHooksRequest();
        Ghostd.hooksRequestFactory = null;
        Ghostd.beginHooksConnectionEpoch();
    }

    function test_initialLoadingReadyAndEmptyStates(): void {
        Ghostd.fetchHooks(false);
        compare(requests.length, 1);
        compare(requests[0].method, "GET");
        verify(requests[0].url.endsWith("/api/hooks"));
        compare(requests[0].headers.Authorization, "Bearer test-token");
        verify(Ghostd.hooksLoading);
        verify(!Ghostd.hooksLoaded);
        compare(Ghostd.currentSessionId, "");
        compare(Object.keys(Ghostd.sessionIds).length, 0);

        requests[0].complete(200, status("Prompt policy"));
        verify(!Ghostd.hooksLoading);
        verify(Ghostd.hooksLoaded);
        compare(Ghostd.activeHookCount, 2);
        compare(Ghostd.activeHooks[0].name, "Prompt policy");

        Ghostd.fetchHooks(true);
        compare(requests.length, 2);
        requests[1].complete(200, {
            active: false,
            total: 0,
            events: [],
            hooks: [],
            sessionStopContinuationCap: 2
        });
        verify(Ghostd.hooksLoaded);
        compare(Ghostd.activeHookCount, 0);
        compare(Ghostd.activeHooks.length, 0);
    }

    function test_refreshKeepsLastGoodCatalogOnHttpOrSchemaError(): void {
        Ghostd.fetchHooks(false);
        requests[0].complete(200, status("Verified"));

        Ghostd.fetchHooks(true);
        compare(Ghostd.activeHooks[0].name, "Verified");
        verify(Ghostd.hooksLoading);
        requests[1].complete(503, {
            error: { code: "shutting_down", message: "Try again." }
        });
        verify(Ghostd.hooksLoaded);
        verify(Ghostd.hooksStale);
        compare(Ghostd.activeHooks[0].name, "Verified");
        verify(Ghostd.hooksError.indexOf("503") >= 0);

        Ghostd.fetchHooks(true);
        const malformed = status("Untrusted replacement");
        malformed.total = 99;
        requests[2].complete(200, malformed);
        verify(Ghostd.hooksLoaded);
        verify(Ghostd.hooksStale);
        compare(Ghostd.activeHooks[0].name, "Verified");
        compare(Ghostd.hooksError, "ghostd sent malformed hook status");
    }

    function test_forceRetiresOutOfOrderCallback(): void {
        Ghostd.fetchHooks(false);
        const stale = requests[0];
        Ghostd.fetchHooks(true);
        verify(stale.aborted);
        stale.complete(200, status("Stale"));
        compare(Ghostd.activeHooks.length, 0);
        requests[1].complete(200, status("Current"));
        compare(Ghostd.activeHooks[0].name, "Current");
    }

    function test_statusZeroResetsStartupEpochAndReconnectsCleanly(): void {
        const before = Ghostd.hooksEpoch;
        Ghostd.fetchHooks(false);
        const stale = requests[0];
        stale.complete(0, "");
        compare(Ghostd.hooksEpoch, before + 1);
        compare(Ghostd.hooksRequest, null);
        verify(!Ghostd.hooksLoading);
        verify(!Ghostd.hooksLoaded);
        compare(Ghostd.activeHooks.length, 0);

        stale.complete(200, status("Too late"));
        compare(Ghostd.activeHooks.length, 0);

        // A healthy daemon response elsewhere starts a fresh catalog request.
        Ghostd.documentsRoot = "/owner/Documents";
        Ghostd.reachable = true;
        tryVerify(function () { return requests.length === 2; });
        requests[1].complete(200, status("After reconnect"));
        verify(Ghostd.hooksLoaded);
        compare(Ghostd.activeHooks[0].name, "After reconnect");
    }

    function test_ghostSessionProjectAndDocumentsChangesDoNotOwnCatalog(): void {
        Ghostd.fetchHooks(false);
        requests[0].complete(200, status("Machine global"));
        const epoch = Ghostd.hooksEpoch;

        Ghostd.activeGhost = "moaning-myrtle";
        Ghostd.currentSessionId = "claude-code:thread-2";
        Ghostd.projectGhost = "moaning-myrtle";
        Ghostd.documentsRoot = "/different/Documents";

        compare(Ghostd.hooksEpoch, epoch);
        compare(Ghostd.activeHooks[0].name, "Machine global");
        compare(requests.length, 1);
    }
}
