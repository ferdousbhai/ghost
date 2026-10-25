import Quickshell
import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

TestCase {
    id: tc
    name: "HooksLifecycle"

    property var requests: []

    readonly property string path: "/owner/.config/ghost/hooks.json"

    function config(name: string): var {
        return {
            path: tc.path,
            document: { hooks: {
                before_prompt: [{ hooks: [{ type: "command", command: "/bin/context", name }] }],
                session_stop: [{ hooks: [{ type: "command", command: "/bin/review", name: "Review" }] }]
            } }
        };
    }

    function firstName(): string {
        return Ghostd.hookConfig.hooks.before_prompt[0].hooks[0].name;
    }

    function init(): void {
        requests = [];
        Ghostd.requestFactory = FakeXhr.factory(tc.requests, /\/api\/hooks/);
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
        Ghostd.reachable = false;
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({});
        Ghostd.apiToken = "test-token";
    }

    function cleanup(): void {
        Ghostd.retire(Ghostd, "hookConfigRequest");
        Ghostd.requestFactory = null;
        Ghostd.beginHooksConnectionEpoch();
    }

    function test_initialLoadingReadyAndEmptyStates(): void {
        Ghostd.fetchHookConfig(false);
        compare(requests.length, 1);
        compare(requests[0].method, "GET");
        verify(requests[0].url.endsWith("/api/hooks/config"));
        compare(requests[0].headers.Authorization, "Bearer test-token");
        verify(Ghostd.hookConfigLoading);
        verify(!Ghostd.hookConfigLoaded);
        compare(Ghostd.currentSessionId, "");
        compare(Object.keys(Ghostd.sessionIds).length, 0);

        requests[0].complete(200, config("Prompt policy"));
        verify(!Ghostd.hookConfigLoading);
        verify(Ghostd.hookConfigLoaded);
        compare(Ghostd.activeHookCount, 2);
        compare(firstName(), "Prompt policy");

        Ghostd.fetchHookConfig(true);
        compare(requests.length, 2);
        requests[1].complete(200, { path: tc.path, document: { hooks: {} } });
        verify(Ghostd.hookConfigLoaded);
        compare(Ghostd.activeHookCount, 0);
    }

    function test_refreshKeepsLastGoodConfigOnHttpOrSchemaError(): void {
        Ghostd.fetchHookConfig(false);
        requests[0].complete(200, config("Verified"));

        Ghostd.fetchHookConfig(true);
        requests[1].complete(503, { error: { code: "shutting_down", message: "Try again." } });
        verify(Ghostd.hookConfigLoaded);
        compare(firstName(), "Verified");
        verify(Ghostd.hookConfigError.indexOf("503") >= 0);

        Ghostd.fetchHookConfig(true);
        requests[2].complete(200, { path: "", document: [] });
        compare(firstName(), "Verified");
        compare(Ghostd.hookConfigError, "ghostd sent a malformed hook configuration");
    }

    function test_forceRetiresOutOfOrderCallback(): void {
        Ghostd.fetchHookConfig(false);
        const stale = requests[0];
        Ghostd.fetchHookConfig(true);
        verify(stale.aborted);
        stale.complete(200, config("Stale"));
        compare(Ghostd.hookConfig, null);
        requests[1].complete(200, config("Current"));
        compare(firstName(), "Current");
    }

    function test_statusZeroResetsStartupEpochAndReconnectsCleanly(): void {
        const before = Ghostd.hooksEpoch;
        Ghostd.fetchHookConfig(false);
        const stale = requests[0];
        stale.complete(0, "");
        compare(Ghostd.hooksEpoch, before + 1);
        compare(Ghostd.hookConfigRequest, null);
        verify(!Ghostd.hookConfigLoaded);
        compare(Ghostd.hookConfig, null);

        stale.complete(200, config("Too late"));
        compare(Ghostd.hookConfig, null);

        // A healthy daemon response elsewhere starts a fresh read. It is
        // deferred with Qt.callLater, so poll; the timeout is a deadlock guard.
        // `reachable` is shared by every test file on this singleton, so a
        // status-0 socket from another connection can drop it while this test
        // yields; re-latch it rather than lose the premise.
        Ghostd.reachable = true;
        tryVerify(function () {
            if (!Ghostd.reachable) Ghostd.reachable = true;
            return requests.length === 2;
        }, 30000, "reachability should start exactly one fresh hooks read");
        requests[1].complete(200, config("After reconnect"));
        verify(Ghostd.hookConfigLoaded);
        compare(firstName(), "After reconnect");
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
            // An admitted write is the live hook set; nothing else is read.
            compare(requests.length, 2);

            Ghostd.writeHookConfig({ hooks: { session_stop: [{ hooks: [{ type: "command", command: "" }] }] } });
            requests[2].complete(400, {
                error: {
                    code: "invalid_request",
                    message: "/owner/.config/ghost/hooks.json: hooks.session_stop[0].hooks[0] must be a command hook with a non-empty NUL-free command."
                }
            });
            compare(finished, [true, false]);
            verify(Ghostd.hookConfigError.indexOf("hooks.session_stop[0].hooks[0]") === 0
                || Ghostd.hookConfigError.indexOf("hooks.json: hooks.session_stop[0]") > 0);
            compare(Object.keys(Ghostd.hookConfig.hooks).length, 0);
            compare(requests.length, 3);
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

    function test_ghostAndSessionChangesDoNotOwnHooks(): void {
        Ghostd.fetchHookConfig(false);
        requests[0].complete(200, config("Machine global"));
        const epoch = Ghostd.hooksEpoch;

        Ghostd.activeGhost = "moaning-myrtle";
        Ghostd.currentSessionId = "thread-2";

        compare(Ghostd.hooksEpoch, epoch);
        compare(firstName(), "Machine global");
        compare(requests.length, 1);
    }
}
