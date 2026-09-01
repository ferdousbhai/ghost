import QtQuick
import QtTest
import qs.services
import "../qml/components" as Components

TestCase {
    id: tc
    name: "LoginLifecycle"
    when: windowShown
    width: 800
    height: 700
    visible: true

    property var requestQueue: []

    Component {
        id: loginPanel
        Components.ModelLogin {
            width: 640
            height: 480
        }
    }

    function request(label: string): var {
        return {
            label: label,
            readyState: 0,
            status: 0,
            responseText: "",
            abortCount: 0,
            openCount: 0,
            sendCount: 0,
            method: "",
            url: "",
            body: null,
            sentBodies: [],
            headers: ({}),
            onreadystatechange: null,
            open: function (method, url) {
                this.openCount += 1;
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function (name, value) {
                this.headers[name] = value;
            },
            send: function (body) {
                this.sendCount += 1;
                this.body = body;
                this.sentBodies.push(body);
            },
            abort: function () {
                this.abortCount += 1;
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
    }

    function useRequests(requests: var): void {
        tc.requestQueue = requests.slice();
        Ghostd.loginRequestFactory = function () {
            if (tc.requestQueue.length === 0) throw new Error("login request queue is empty");
            return tc.requestQueue.shift();
        };
    }

    function complete(xhr: var, status: int, body: var): void {
        xhr.status = status;
        xhr.responseText = JSON.stringify(body);
        xhr.readyState = 4;
        xhr.onreadystatechange();
    }

    function init(): void {
        Ghostd.cancelLogin();
        Ghostd.loginRequestFactory = null;
        Ghostd.renameGhostRequestFactory = null;
        Ghostd.tokenReloadOverride = null;
        Ghostd.apiToken = "";
        Ghostd.providers = [];
        Ghostd.ghosts = [{ name: "casper", dir: "/tmp/ghosts/casper" }];
        Ghostd.renamingGhost = "";
        Ghostd.deletingGhost = "";
        Ghostd.renameGhostRequest = null;
        Ghostd.renameGhostSnapshot = null;
        Ghostd.activeGhost = "casper";
        Ghostd.cancelLogin();
    }

    function cleanup(): void {
        Ghostd.cancelLogin();
        Ghostd.loginRequestFactory = null;
        Ghostd.renameGhostRequestFactory = null;
        Ghostd.tokenReloadOverride = null;
        Ghostd.apiToken = "";
        tc.requestQueue = [];
    }

    function test_everyRequestIsRetainedAndNewerInputRetiresThePoll(): void {
        const providers = tc.request("providers");
        const start = tc.request("start");
        const poll = tc.request("poll");
        const input = tc.request("input");
        const cancelledInput = tc.request("cancelled-input");
        tc.useRequests([providers, start, poll, input, cancelledInput]);

        Ghostd.fetchProviders();
        compare(Ghostd.providersRequest, providers);

        Ghostd.startLogin("openrouter", "oauth");
        compare(providers.abortCount, 1);
        compare(Ghostd.loginStartRequest, start);
        tc.complete(providers, 200, { providers: [{ id: "stale" }] });
        compare(Ghostd.providers.length, 0);

        tc.complete(start, 201, {
            loginId: "login-current",
            providerId: "openrouter",
            authType: "oauth",
            status: "awaiting_input"
        });
        compare(Ghostd.loginStartRequest, null);
        verify(Ghostd.loginPolling);

        Ghostd.pollLogin();
        compare(Ghostd.loginPollRequest, poll);
        Ghostd.submitLoginInput("first-code");
        compare(poll.abortCount, 1);
        compare(Ghostd.loginPollRequest, null);
        compare(Ghostd.loginInputRequest, input);

        tc.complete(input, 200, {
            loginId: "login-current",
            providerId: "openrouter",
            authType: "oauth",
            status: "working",
            message: "newer input response"
        });
        compare(Ghostd.loginState.message, "newer input response");
        tc.complete(poll, 200, {
            loginId: "login-current",
            status: "failed",
            error: "stale poll"
        });
        compare(Ghostd.loginState.message, "newer input response");

        Ghostd.submitLoginInput("second-code");
        compare(Ghostd.loginInputRequest, cancelledInput);
        Ghostd.cancelLogin();
        compare(cancelledInput.abortCount, 1);
        compare(Ghostd.loginInputRequest, null);
        compare(Ghostd.loginId, "");
        verify(!Ghostd.loginPolling);
    }

    function test_reorderedOlderStartCannotReplaceTheNewFlow(): void {
        const older = tc.request("older");
        const newer = tc.request("newer");
        tc.useRequests([older, newer]);

        Ghostd.startLogin("openrouter", "oauth");
        Ghostd.startLogin("anthropic", "api_key");
        compare(older.abortCount, 1);
        compare(Ghostd.loginStartRequest, newer);

        tc.complete(newer, 201, {
            loginId: "login-new",
            providerId: "anthropic",
            authType: "api_key",
            status: "awaiting_input",
            message: "new flow"
        });
        compare(Ghostd.loginId, "login-new");
        compare(Ghostd.loginState.message, "new flow");

        tc.complete(older, 201, {
            loginId: "login-old",
            providerId: "openrouter",
            authType: "oauth",
            status: "failed",
            error: "late old flow"
        });
        compare(Ghostd.loginId, "login-new");
        compare(Ghostd.loginState.message, "new flow");
        verify(Ghostd.loginPolling);
    }

    function test_actualRenameKeepsOldRouteUntilMoveThenRejectsOldRouteResponses(): void {
        const start = tc.request("start");
        const oldPoll = tc.request("old-poll");
        const oldInput = tc.request("old-input");
        const mismatchedPoll = tc.request("mismatched-poll");
        const newPoll = tc.request("new-poll");
        const rename = tc.request("rename");
        tc.useRequests([start, oldPoll, oldInput, mismatchedPoll, newPoll]);
        Ghostd.renameGhostRequestFactory = function () { return rename; };

        Ghostd.startLogin("openrouter", "oauth");
        tc.complete(start, 201, {
            loginId: "login-rename",
            providerId: "openrouter",
            authType: "oauth",
            status: "working"
        });
        Ghostd.pollLogin();
        const generation = Ghostd.loginGeneration;
        compare(oldPoll.url, Ghostd.baseUrl
            + "/api/ghosts/casper/login/login-rename");

        // Input is still safe on the old route before the rename begins. The
        // rename must retire it rather than guessing which route now exists.
        verify(Ghostd.submitLoginInput("before-rename-secret"));
        compare(oldPoll.abortCount, 1);
        compare(oldInput.url, Ghostd.baseUrl
            + "/api/ghosts/casper/login/login-rename/input");

        verify(Ghostd.renameGhost("casper", "renamed"));
        compare(rename.method, "PUT");
        compare(rename.url, Ghostd.baseUrl + "/api/ghosts/casper/name");
        // UI-owned keys move optimistically, but login traffic pauses until
        // the rename XHR publishes which daemon route is authoritative.
        compare(Ghostd.loginGhost, "renamed");
        compare(Ghostd.loginRouteGhost, "casper");
        verify(Ghostd.loginRoutePaused);
        compare(Ghostd.activeGhost, "renamed");
        compare(Ghostd.loginGeneration, generation);
        compare(Ghostd.loginId, "login-rename");
        compare(oldInput.abortCount, 1);
        compare(tc.requestQueue.length, 2);
        verify(!Ghostd.submitLoginInput("during-rename-secret"));
        compare(tc.requestQueue.length, 2);

        tc.complete(rename, 200, { name: "renamed" });
        compare(Ghostd.loginRouteGhost, "renamed");
        verify(!Ghostd.loginRoutePaused);
        compare(Ghostd.loginId, "login-rename");
        compare(Ghostd.loginGeneration, generation);

        Ghostd.pollLogin();
        compare(mismatchedPoll.url, Ghostd.baseUrl
            + "/api/ghosts/renamed/login/login-rename");

        tc.complete(oldInput, 200, {
            loginId: "login-rename",
            status: "failed",
            error: "stale old-route response"
        });
        compare(Ghostd.loginState.message, undefined);

        tc.complete(mismatchedPoll, 200, {
            loginId: "different-login",
            status: "failed",
            error: "wrong login identity"
        });
        compare(Ghostd.loginState.message, undefined);
        compare(Ghostd.loginError, "ghostd sent a malformed login step");

        Ghostd.pollLogin();
        compare(newPoll.url, Ghostd.baseUrl
            + "/api/ghosts/renamed/login/login-rename");
        tc.complete(newPoll, 200, {
            loginId: "login-rename",
            status: "working",
            message: "new-route response"
        });
        compare(Ghostd.loginState.message, "new-route response");

        Ghostd.activeGhost = "another";
        verify(Ghostd.loginGeneration > generation);
        compare(newPoll.abortCount, 0);
        compare(Ghostd.loginId, "");
        compare(Ghostd.loginGhost, "");
        compare(Ghostd.loginRouteGhost, "");
        verify(!Ghostd.loginPolling);
    }

    function test_changedTokenInputRetryDoesNotResendSecretAfterPanelClose(): void {
        const start = tc.request("start");
        const input = tc.request("input");
        tc.useRequests([start, input]);

        Ghostd.startLogin("anthropic", "api_key");
        tc.complete(start, 201, {
            loginId: "login-secret",
            providerId: "anthropic",
            authType: "api_key",
            status: "awaiting_input"
        });
        Ghostd.apiToken = "old-token";
        Ghostd.tokenReloadOverride = function () { return "new-token"; };
        verify(Ghostd.submitLoginInput("sk-private-value"));
        compare(input.sendCount, 1);
        compare(input.openCount, 1);
        compare(input.sentBodies[0], JSON.stringify({ value: "sk-private-value" }));

        // The changed token schedules a callLater replay while this XHR is DONE,
        // which means abort() cannot retire it by itself.
        tc.complete(input, 401, { error: "rotated" });
        compare(Ghostd.loginInputRequest, input);
        const panel = createTemporaryObject(loginPanel, tc);
        verify(panel !== null);
        panel.close();
        wait(0);

        compare(input.abortCount, 0);
        compare(input.openCount, 1);
        compare(input.sendCount, 1);
        compare(input.sentBodies.length, 1);
        compare(Ghostd.loginInputRequest, null);
        compare(Ghostd.loginId, "");
    }

    function test_rejectedInputCannotSurviveCloseHideOrAReplacementFlow(): void {
        const start = tc.request("start");
        const providers = tc.request("providers");
        tc.useRequests([start]);
        Ghostd.startLogin("anthropic", "api_key");
        tc.complete(start, 201, {
            loginId: "login-retained-secret",
            providerId: "anthropic",
            authType: "api_key",
            status: "awaiting_input",
            prompt: { kind: "secret", message: "API key" }
        });

        // No visual parent: TestCase itself is hidden, which would make this
        // panel effectively hidden before the transition under test.
        const panel = createTemporaryObject(loginPanel, null);
        verify(panel !== null);
        const field = findChild(panel, "loginCodeField");
        verify(field !== null);
        field.text = "sk-must-not-cross-flows";

        // A rename pause rejects submission without ending this flow, so the
        // owner can retry once its route settles.
        Ghostd.loginRoutePaused = true;
        panel.submitCurrentInput();
        compare(field.text, "sk-must-not-cross-flows");
        compare(tc.requestQueue.length, 0);

        panel.close();
        compare(field.text, "");
        field.text = "second-secret";
        panel.visible = false;
        compare(field.text, "");

        // Reopening starts another generation and provider fetch; the same
        // persistent component must not repopulate either rejected value.
        panel.visible = true;
        tc.useRequests([providers]);
        panel.open("");
        compare(field.text, "");
        compare(Ghostd.providersRequest, providers);
    }

    function test_requestedProviderIsFocusedAndScrolledIntoView(): void {
        const providers = tc.request("providers");
        const start = tc.request("start");
        tc.useRequests([providers, start]);
        const panel = createTemporaryObject(loginPanel, tc, {
            height: 180,
            visible: true
        });
        verify(panel !== null);

        panel.open("target-provider");
        tc.complete(providers, 200, { providers: [
            { id: "one", name: "One", authTypes: ["oauth"] },
            { id: "two", name: "Two", authTypes: ["oauth"] },
            { id: "three", name: "Three", authTypes: ["oauth"] },
            { id: "four", name: "Four", authTypes: ["oauth"] },
            { id: "target-provider", name: "Target", authTypes: ["oauth"] }
        ] });

        const target = findChild(panel, "provider-target-provider");
        const list = findChild(panel, "providerList");
        verify(target !== null);
        verify(list !== null);
        tryVerify(function () { return target.activeFocus; });
        tryVerify(function () { return list.contentY > 0; });
        compare(panel.requestedProvider, "target-provider");

        keyClick(Qt.Key_Return);
        compare(Ghostd.loginStartRequest, start);
        compare(JSON.parse(start.body), {
            providerId: "target-provider",
            authType: "oauth"
        });
    }

    function test_panelCloseAbortsTheFlowBeforeItDismisses(): void {
        const start = tc.request("start");
        const poll = tc.request("poll");
        tc.useRequests([start, poll]);
        Ghostd.activeGhost = "casper";
        Ghostd.startLogin("openrouter", "oauth");
        tc.complete(start, 201, {
            loginId: "login-panel",
            providerId: "openrouter",
            authType: "oauth",
            status: "working"
        });
        Ghostd.pollLogin();
        compare(Ghostd.loginPollRequest, poll);

        const panel = createTemporaryObject(loginPanel, tc);
        verify(panel !== null);
        let closes = 0;
        panel.closeRequested.connect(function () { closes += 1; });
        panel.close();

        compare(closes, 1);
        compare(poll.abortCount, 1);
        compare(Ghostd.loginPollRequest, null);
        compare(Ghostd.loginId, "");
        verify(!Ghostd.loginPolling);
    }

    function test_panelDestructionAbortsTheFlow(): void {
        const start = tc.request("start");
        const poll = tc.request("poll");
        tc.useRequests([start, poll]);
        Ghostd.startLogin("openrouter", "oauth");
        tc.complete(start, 201, {
            loginId: "login-teardown",
            providerId: "openrouter",
            authType: "oauth",
            status: "working"
        });
        Ghostd.pollLogin();
        compare(Ghostd.loginPollRequest, poll);

        const panel = createTemporaryObject(loginPanel, tc);
        verify(panel !== null);
        panel.destroy();
        wait(0);

        compare(poll.abortCount, 1);
        compare(Ghostd.loginPollRequest, null);
        compare(Ghostd.loginId, "");
        verify(!Ghostd.loginPolling);
    }
}
