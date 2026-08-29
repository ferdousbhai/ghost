import QtQuick
import QtTest
import qs.services

TestCase {
    name: "RecapLifecycle"

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
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            }
        };
        requests.push(xhr);
        return xhr;
    }

    function activeState(id: string, runtime: string): var {
        const publicId = runtime + ":" + id;
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = publicId;
        Ghostd.sessionIds = ({ casper: publicId });
        const state = Ghostd.ensureTurnState("casper", publicId, id, runtime);
        state.streaming = false;
        state.rows = [{
            role: "assistant", text: "Done.", tools: "", toolActivity: [],
            error: "", pending: false, entryId: "assistant-1"
        }];
        Ghostd.showTurnState("casper", publicId);
        return state;
    }

    function init(): void {
        Ghostd.clearRecap();
        Ghostd.composerHasDraft = false;
        Ghostd.recapIdleMs = 5;
        Ghostd.turnStates = ({});
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "";
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.apiToken = "test-token";
        Ghostd.lastError = "";
        requests = [];
        Ghostd.recapRequestFactory = function () { return fakeRequest(); };
    }

    function cleanup(): void {
        Ghostd.clearRecap();
        Ghostd.composerHasDraft = false;
        Ghostd.recapRequestFactory = null;
        Ghostd.recapIdleMs = 240000;
        Ghostd.turnStates = ({});
        Ghostd.currentSessionId = "";
    }

    function test_idlePiConversationPaintsRecap(): void {
        const state = activeState("recap-one", "pi");
        Ghostd.scheduleRecapFor(state);
        wait(20);

        compare(requests.length, 1);
        compare(requests[0].method, "POST");
        verify(requests[0].url.indexOf("/sessions/pi%3Arecap-one/recap") >= 0);
        compare(requests[0].body, "{}");
        requests[0].complete(200, { recap: "Return to the launch plan. Next: finish the opening." });

        compare(Ghostd.recapText,
            "Return to the launch plan. Next: finish the opening.");
    }

    function test_typingClearsResultAndAbortsInflightRequest(): void {
        const state = activeState("recap-two", "pi");
        Ghostd.scheduleRecapFor(state);
        wait(20);
        compare(requests.length, 1);

        Ghostd.composerHasDraft = true;
        verify(requests[0].aborted);
        compare(Ghostd.recapText, "");

        Ghostd.composerHasDraft = false;
        Ghostd.scheduleRecapFor(state);
        wait(20);
        requests[1].complete(200, { recap: "A recap that should clear." });
        compare(Ghostd.recapText, "A recap that should clear.");
        Ghostd.composerHasDraft = true;
        compare(Ghostd.recapText, "");
    }

    function test_navigationDropsStaleResponseAndClaudeNeverArms(): void {
        const state = activeState("source", "pi");
        Ghostd.scheduleRecapFor(state);
        wait(20);
        compare(requests.length, 1);

        activeState("other", "pi");
        verify(requests[0].aborted);
        requests[0].complete(200, { recap: "Stale source recap." });
        compare(Ghostd.recapText, "");

        const claude = activeState("claude", "claude-code");
        Ghostd.scheduleRecapFor(claude);
        wait(20);
        compare(requests.length, 1);
    }

    function test_failuresStaySilent(): void {
        const state = activeState("failure", "pi");
        Ghostd.scheduleRecapFor(state);
        wait(20);
        const previousError = Ghostd.lastError;
        requests[0].complete(503, { error: { code: "provider_error" } });

        compare(Ghostd.recapText, "");
        compare(Ghostd.lastError, previousError);
    }
}
