import Quickshell
import QtQuick
import QtTest
import qs.services

TestCase {
    id: tc
    name: "HooksLifecycle"

    property var requests: []

    function fakeRequest(bucket: var): var {
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
        bucket.push(xhr);
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
                { event: "before_prompt", source: "config", name, description: "Adds bounded context." },
                {
                    event: "conversation_idle",
                    source: "builtin",
                    name: "Memory upkeep",
                    description: "Runs after inactivity.",
                    idleSeconds: 60
                }
            ],
            sessionStopContinuationCap: 10
        };
    }

    function init(): void {
        requests = [];
        Ghostd.hooksRequestFactory = function () { return tc.fakeRequest(tc.requests); };
        Ghostd.beginHooksConnectionEpoch();
        // The catalog is the only daemon connection this file asserts on, but
        // every connection on the shared singleton drives one `reachable` latch,
        // and a false latch retires the hooks epoch through onReachableChanged.
        // Ghostd's other connections open real sockets to the unreachable test
        // port; their status-0 failures land whenever the event loop reaches
        // them, which on a loaded machine is inside some later test. Disown the
        // ones a neighbouring test file can leave in flight so this file opens
        // no socket of its own either.
        Ghostd.listRequest = null;
        Ghostd.cancelAllTranscriptLoads();
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
            sessionStopContinuationCap: 10
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
        Ghostd.reachable = true;
        // The catalog request is deferred with Qt.callLater, so poll for it;
        // the timeout is a deadlock guard, not an expected wait. `reachable` is
        // machine-wide state on a singleton every test file shares, so a
        // status-0 socket belonging to some other connection can drop it at any
        // point this test yields — which would leave the catalog waiting on an
        // edge that never comes back. Re-latch it rather than lose the premise.
        tryVerify(function () {
            if (!Ghostd.reachable) Ghostd.reachable = true;
            return requests.length === 2;
        }, 30000, "reachability should start exactly one fresh catalog request");
        compare(requests.length, 2);
        requests[1].complete(200, status("After reconnect"));
        verify(Ghostd.hooksLoaded);
        compare(Ghostd.activeHooks[0].name, "After reconnect");
    }

    function test_configIsReadWrittenAndRefusedThroughTheDaemon(): void {
        const document = {
            hooks: { before_prompt: [{ hooks: [{ type: "command", command: "/bin/true" }] }] }
        };
        let finished = [];
        const watcher = function (ok) { finished.push(ok); };
        Ghostd.hookConfigWriteFinished.connect(watcher);
        try {
            Ghostd.fetchHookConfig(false);
            compare(requests.length, 1);
            compare(requests[0].method, "GET");
            verify(requests[0].url.endsWith("/api/hooks/config"));
            verify(Ghostd.hookConfigLoading);
            requests[0].complete(200, { path: "/owner/.config/ghost/hooks.json", document });
            verify(Ghostd.hookConfigLoaded);
            verify(Ghostd.hookConfigAvailable);
            compare(Ghostd.hookConfigPath, "/owner/.config/ghost/hooks.json");
            compare(Ghostd.hookConfig.hooks.before_prompt[0].hooks[0].command, "/bin/true");

            const next = { hooks: {} };
            Ghostd.writeHookConfig(next);
            compare(requests.length, 2);
            compare(requests[1].method, "PUT");
            verify(requests[1].url.endsWith("/api/hooks/config"));
            compare(requests[1].headers["Content-Type"], "application/json");
            compare(JSON.parse(requests[1].body), next);
            verify(Ghostd.hookConfigBusy);
            requests[1].complete(200, { path: "/owner/.config/ghost/hooks.json", document: next });
            verify(!Ghostd.hookConfigBusy);
            compare(finished, [true]);
            compare(Object.keys(Ghostd.hookConfig.hooks).length, 0);
            // An admitted write is live at once, so the status is re-read.
            compare(requests.length, 3);
            compare(requests[2].method, "GET");
            verify(requests[2].url.endsWith("/api/hooks"));

            Ghostd.writeHookConfig({ hooks: { session_stop: [{ hooks: [{ type: "command", command: "" }] }] } });
            requests[3].complete(400, {
                error: {
                    code: "invalid_request",
                    message: "/owner/.config/ghost/hooks.json: hooks.session_stop[0].hooks[0] must be a command hook with a non-empty NUL-free command."
                }
            });
            compare(finished, [true, false]);
            verify(Ghostd.hookConfigError.indexOf("hooks.session_stop[0].hooks[0]") === 0
                || Ghostd.hookConfigError.indexOf("hooks.json: hooks.session_stop[0]") > 0);
            compare(Object.keys(Ghostd.hookConfig.hooks).length, 0);
            compare(requests.length, 4);
        } finally {
            Ghostd.hookConfigWriteFinished.disconnect(watcher);
        }
    }

    function test_configIsUnavailableOnADaemonWithoutAFile(): void {
        Ghostd.fetchHookConfig(false);
        requests[0].complete(404, { error: { code: "not_found", message: "Hook configuration is not available." } });
        verify(Ghostd.hookConfigLoaded);
        verify(!Ghostd.hookConfigAvailable);
        compare(Ghostd.hookConfigError, "");
        Ghostd.writeHookConfig({ hooks: {} });
        compare(requests.length, 1);
    }

    function test_ghostSessionAndProjectChangesDoNotOwnCatalog(): void {
        Ghostd.fetchHooks(false);
        requests[0].complete(200, status("Machine global"));
        const epoch = Ghostd.hooksEpoch;

        Ghostd.activeGhost = "moaning-myrtle";
        Ghostd.currentSessionId = "claude-code:thread-2";
        Ghostd.projectGhost = "moaning-myrtle";

        compare(Ghostd.hooksEpoch, epoch);
        compare(Ghostd.activeHooks[0].name, "Machine global");
        compare(requests.length, 1);
    }
}
