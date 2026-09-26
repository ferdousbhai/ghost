import QtQuick
import QtTest
import "../qml/services"
import "../qml/components" as Components

// The model chip's pane: it lists what `GET /models` reports, narrows it by
// search, binds a choice with `PUT /model`, hands it back with `DELETE`, and
// swaps in a searchable provider sign-in. These drive the real component and
// Ghostd against scripted requests.
TestCase {
    id: tc
    name: "ModelPicker"
    when: windowShown
    width: 800
    height: 700
    visible: true

    property var sent: []

    Component {
        id: pickerComponent
        Components.ModelPicker {
            width: 640
            height: 480
        }
    }

    function request(): var {
        const xhr = {
            readyState: 0, status: 0, responseText: "", method: "", url: "", body: null,
            onreadystatechange: null,
            open: function (method, url) { this.method = method; this.url = url; this.readyState = 1; },
            setRequestHeader: function () {},
            send: function (body) { this.body = body; },
            abort: function () { this.readyState = 4; }
        };
        tc.sent.push(xhr);
        return xhr;
    }

    function complete(xhr: var, body: var): void {
        xhr.status = 200;
        xhr.responseText = JSON.stringify(body);
        xhr.readyState = 4;
        xhr.onreadystatechange();
    }

    function init(): void {
        tc.sent = [];
        Ghostd.ghosts = [{ name: "casper", dir: "/tmp/ghosts/casper" }];
        Ghostd.activeGhost = "casper";
        Ghostd.currentModel = { provider: "openrouter", id: "free:a" };
        Ghostd.modelSource = "explicit";
        Ghostd.modelError = "";
        Ghostd.modelRequestFactory = tc.request;
        Ghostd.loginRequestFactory = tc.request;
    }

    function cleanup(): void {
        Ghostd.cancelLogin();
        Ghostd.modelRequestFactory = null;
        Ghostd.loginRequestFactory = null;
        Ghostd.availableModels = [];
        Ghostd.providers = [];
        Ghostd.currentModel = null;
        Ghostd.modelSource = "none";
    }

    function openPicker(): var {
        const picker = createTemporaryObject(pickerComponent, tc);
        picker.open(false);
        compare(tc.sent[0].url.slice(-"/api/ghosts/casper/models".length), "/api/ghosts/casper/models");
        tc.complete(tc.sent[0], { models: [
            { provider: "openrouter", id: "free:a", name: "Free A" },
            { provider: "xai", id: "grok-4.6", name: "Grok 4.6" },
            { provider: "xai", id: "grok-4.5", name: "Grok 4.5" }
        ] });
        return picker;
    }

    function test_searchNarrowsAndChoosingBindsTheModel(): void {
        const picker = openPicker();
        compare(picker.rows.length, 4, "Default leads the unfiltered list");
        verify(picker.isCurrent(picker.rows[1]));

        const search = findChild(picker, "modelSearch");
        search.text = "GROK";
        compare(picker.rows.map(row => row.id), ["grok-4.6", "grok-4.5"]);

        search.moved(1);
        search.accepted();
        const put = tc.sent[tc.sent.length - 1];
        compare(put.method, "PUT");
        compare(JSON.parse(put.body), { provider: "xai", id: "grok-4.5" });
        tc.complete(put, { current: { provider: "xai", id: "grok-4.5", runtime: "pi" }, source: "explicit" });
        compare(Ghostd.currentModel.id, "grok-4.5");
    }

    // Return with nothing moved or typed keeps what is bound: the highlight
    // starts on the current model, never on Default.
    function test_highlightStartsOnTheCurrentModel(): void {
        const picker = openPicker();
        compare(findChild(picker, "modelList").currentIndex, 1);
    }

    // The pane stays up until the daemon answers: a refusal is shown in it, and
    // only a success closes it.
    function test_aRefusedSwitchStaysOpenWithTheReason(): void {
        const picker = openPicker();
        const closed = createTemporaryObject(spyComponent, tc, { target: picker, signalName: "closeRequested" });
        picker.choose(picker.rows[2]);
        const put = tc.sent[tc.sent.length - 1];
        put.status = 400;
        put.responseText = JSON.stringify({ error: { code: "invalid_request", message: "A model is written as provider/id." } });
        put.readyState = 4;
        put.onreadystatechange();
        compare(closed.count, 0);
        verify(Ghostd.modelError.indexOf("provider/id") >= 0);

        picker.choose(picker.rows[2]);
        tc.complete(tc.sent[tc.sent.length - 1],
            { current: { provider: "xai", id: "grok-4.6", runtime: "pi" }, source: "explicit" });
        compare(closed.count, 1);
    }

    function test_defaultIsOfferedEvenWithNothingReachable(): void {
        const picker = createTemporaryObject(pickerComponent, tc);
        picker.open(false);
        tc.complete(tc.sent[0], { models: [] });
        compare(picker.rows, [null]);
    }

    Component {
        id: spyComponent
        SignalSpy {}
    }

    function test_defaultHandsTheChoiceBack(): void {
        const picker = openPicker();
        picker.choose(picker.rows[0]);
        const del = tc.sent[tc.sent.length - 1];
        compare(del.method, "DELETE");
        tc.complete(del, { current: { provider: "openrouter", id: "free:a", runtime: "pi" }, source: "none" });
        verify(picker.isCurrent(null));
    }

    // Unbound with nothing declared, the daemon reports no current model; with
    // models reachable pi still answers, so the HUD must not call it empty.
    function test_anUnresolvedDefaultIsNotNoModel(): void {
        const picker = openPicker();
        picker.choose(picker.rows[0]);
        tc.complete(tc.sent[tc.sent.length - 1], { current: null, source: "none" });
        compare(Ghostd.currentModel, null);
        verify(!Ghostd.noModel);
    }

    function test_noModelWhenNothingResolvesOrIsReachable(): void {
        Ghostd.currentModel = null;
        Ghostd.availableModels = [];
        verify(Ghostd.noModel);
    }

    function test_connectingSearchesProvidersAndBackReturnsToTheList(): void {
        const picker = openPicker();
        findChild(picker, "connectProvider").clicked();
        verify(picker.connecting);
        const providers = tc.sent[tc.sent.length - 1];
        tc.complete(providers, { providers: [
            { id: "openrouter", name: "OpenRouter", authTypes: ["oauth", "api_key"] },
            { id: "xai", name: "xAI", authTypes: ["oauth", "api_key"], subscription: true }
        ] });
        const login = findChild(picker, "modelLogin");
        compare(login.shownProviders.length, 2);
        const search = findChild(login, "providerSearch");
        search.text = "xa";
        compare(login.shownProviders.map(provider => provider.id), ["xai"]);

        // An empty search's Return starts nothing: a sign-in may bill.
        search.text = "";
        const before = tc.sent.length;
        search.accepted();
        compare(tc.sent.length, before);

        // Back without a sign-in returns to the list as it was: no re-listing.
        const sentBeforeBack = tc.sent.length;
        login.close();
        verify(!picker.connecting);
        compare(tc.sent.length, sentBeforeBack);
    }
}
