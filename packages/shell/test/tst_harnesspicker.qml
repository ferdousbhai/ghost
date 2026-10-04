import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"
import "FakeXhr.js" as FakeXhr

// The header's harness picker: which harness runs the open conversation's next
// turn, and the ghost's own default (GET/PUT /harness, PUT .../harness).
TestCase {
    id: tc
    name: "HarnessPicker"
    when: windowShown
    width: 700
    height: 400
    visible: true

    property var requests: []

    Component {
        id: headerComponent
        HudHeader {
            width: 600
        }
    }

    function choice(overrides: var): var {
        return Object.assign({
            harnesses: [
                { id: "claude", eligible: true, reason: null, usage: null },
                { id: "codex", eligible: false, reason: "weekly window is full", usage: null },
                { id: "pi", eligible: true, reason: null, usage: null }
            ],
            ghostDefault: null,
            omarchyDefault: "claude"
        }, overrides || {});
    }

    function init(): void {
        tc.requests = [];
        Ghostd.harnessRequestFactory = function () { return FakeXhr.make(tc.requests); };
        Ghostd.apiToken = "test-token";
        Ghostd.activeGhost = "casper";
        Ghostd.clearHarnessChoice();
        Ghostd.pendingHarnesses = ({});
        Ghostd.turnStates = ({});
        Ghostd.sessionIds = ({ casper: "a" });
        Ghostd.sessions = [{ id: "a", title: "x", harness: "claude", messageCount: 2 }];
        Ghostd.currentSessionId = "a";
    }

    function cleanup(): void {
        Ghostd.harnessRequestFactory = null;
        Ghostd.clearHarnessChoice();
        Ghostd.harnessSessionRequest = null;
        Ghostd.pendingHarnesses = ({});
        Ghostd.turnStates = ({});
        Ghostd.sessions = [];
        Ghostd.currentSessionId = "";
    }

    /** Click a named part once the picker's rows have been laid out: a new
        agent list rebuilds them, and a Column positions them at the next polish. */
    function click(header: var, name: string): void {
        waitForRendering(header);
        const target = findChild(header, name);
        verify(target !== null, name);
        mouseClick(target);
    }

    /** A header with its picker open and the GET answered. */
    function openPicker(body: var): var {
        const header = createTemporaryObject(headerComponent, tc);
        verify(header !== null);
        tc.click(header, "harnessLabel");
        verify(header.pickerOpen);
        tc.requests[0].complete(200, body || tc.choice());
        return header;
    }

    function test_openingThePickerReadsTheAgents(): void {
        const header = createTemporaryObject(headerComponent, tc);
        compare(findChild(header, "harnessLabel").text, "via claude ▾");
        tc.click(header, "harnessLabel");
        compare(tc.requests.length, 1);
        compare(tc.requests[0].method, "GET");
        verify(tc.requests[0].url.endsWith("/api/ghosts/casper/harness"));
        tc.requests[0].complete(200, tc.choice());
        compare(Ghostd.harnessChoice.harnesses.length, 3);
        compare(Ghostd.harnessChoice.omarchyDefault, "claude");
        verify(findChild(header, "harnessPicker").visible);
        verify(!findChild(header, "harnessChoose-codex").enabled);
        verify(findChild(header, "harnessChoose-pi").enabled);
    }

    function test_aFailedReadShowsQuietlyInThePicker(): void {
        const header = createTemporaryObject(headerComponent, tc);
        tc.click(header, "harnessLabel");
        tc.requests[0].complete(500, { error: { code: "internal", message: "boom" } });
        compare(Ghostd.harnessChoice, null);
        compare(Ghostd.harnessError, "GET harnesses → 500: boom");
        verify(findChild(header, "harnessError").visible);
    }

    function test_choosingAnAgentPutsTheConversationRoute(): void {
        const header = openPicker(null);
        tc.click(header, "harnessChoose-pi");
        compare(tc.requests.length, 2);
        compare(tc.requests[1].method, "PUT");
        verify(tc.requests[1].url.endsWith("/api/ghosts/casper/sessions/a/harness"));
        compare(JSON.parse(tc.requests[1].body), { harness: "pi" });
        compare(Ghostd.currentHarness, "pi");
        compare(findChild(header, "harnessLabel").text, "via pi ▾");
        verify(!header.pickerOpen);
        tc.requests[1].complete(200, { id: "a", harness: "pi" });
        compare(Ghostd.currentHarness, "pi");

        // The pick holds until a listing reports it, then the row speaks.
        Ghostd.settlePendingHarnesses("casper", [{ id: "a", harness: "claude" }]);
        compare(Ghostd.currentHarness, "pi");
        Ghostd.sessions = [{ id: "a", title: "x", harness: "pi", messageCount: 4 }];
        Ghostd.settlePendingHarnesses("casper", Ghostd.sessions);
        compare(Ghostd.pendingHarnesses, ({}));
        compare(Ghostd.currentHarness, "pi");
    }

    function test_aRefusedChoiceRevertsTheLabel(): void {
        openPicker(null);
        Ghostd.chooseHarness("pi");
        tc.requests[1].complete(400, { error: { code: "unknown_harness", message: "no agent pi" } });
        compare(Ghostd.currentHarness, "claude");
        compare(Ghostd.harnessError, "PUT conversation harness → 400: no agent pi");
    }

    function test_aDraftCarriesItsPickBeforeItIsListed(): void {
        Ghostd.sessionIds = ({ casper: "" });
        Ghostd.sessions = [];
        Ghostd.currentSessionId = "";
        const header = createTemporaryObject(headerComponent, tc);
        compare(findChild(header, "harnessLabel").text, "harness: automatic ▾");
        tc.click(header, "harnessLabel");
        tc.requests[0].complete(200, tc.choice());
        tc.click(header, "harnessChoose-pi");

        const draft = Ghostd.currentSessionId;
        verify(Ghostd.validConversationId(draft));
        compare(tc.requests[1].method, "PUT");
        verify(tc.requests[1].url.endsWith("/api/ghosts/casper/sessions/" + draft + "/harness"));
        compare(JSON.parse(tc.requests[1].body), { harness: "pi" });
        tc.requests[1].complete(200, { id: draft, harness: "pi" });
        compare(Ghostd.currentHarness, "pi");
        compare(findChild(header, "harnessLabel").text, "via pi ▾");
    }

    function test_settingAndClearingTheGhostDefault(): void {
        const header = openPicker(null);
        verify(findChild(header, "harnessAutomatic").isDefault);

        tc.click(header, "harnessDefault-pi");
        compare(tc.requests[1].method, "PUT");
        verify(tc.requests[1].url.endsWith("/api/ghosts/casper/harness"));
        compare(JSON.parse(tc.requests[1].body), { harness: "pi" });
        compare(Ghostd.harnessChoice.ghostDefault, "pi");
        tc.requests[1].complete(200, tc.choice({ ghostDefault: "pi" }));
        compare(Ghostd.harnessChoice.ghostDefault, "pi");
        verify(!findChild(header, "harnessAutomatic").isDefault);

        // The same toggle clears it; so does the automatic row.
        tc.click(header, "harnessDefault-pi");
        compare(JSON.parse(tc.requests[2].body), { harness: null });
        tc.requests[2].complete(200, tc.choice());
        compare(Ghostd.harnessChoice.ghostDefault, null);

        Ghostd.setGhostHarness("claude");
        tc.requests[3].complete(200, tc.choice({ ghostDefault: "claude" }));
        tc.click(header, "harnessAutomatic");
        compare(JSON.parse(tc.requests[4].body), { harness: null });
        tc.requests[4].complete(200, tc.choice());
        verify(findChild(header, "harnessAutomatic").isDefault);
    }

    function test_aRefusedDefaultPutsTheOldOneBack(): void {
        openPicker(tc.choice({ ghostDefault: "claude" }));
        Ghostd.setGhostHarness("pi");
        compare(Ghostd.harnessChoice.ghostDefault, "pi");
        tc.requests[1].complete(400, { error: { code: "unknown_harness", message: "nope" } });
        compare(Ghostd.harnessChoice.ghostDefault, "claude");
        verify(Ghostd.harnessError !== "");
    }
}
