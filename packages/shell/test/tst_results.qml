import QtQuick
import QtTest
import "../qml/services"
import "../qml/components" as Components
import "FakeXhr.js" as FakeXhr

TestCase {
    id: tc
    name: "SharedResults"
    when: windowShown
    visible: true
    width: 900
    height: 650
    property var requests: []
    Component { id: paneComponent; Components.Results { width: 900; height: 650 } }
    function init(): void {
        Ghostd.retireClientRequests(); tc.requests = [];
        Ghostd.requestFactory = FakeXhr.factory(tc.requests, /\/results/);
        Ghostd.activeGhost = "casper"; Ghostd.currentSessionId = "c1";
        Ghostd.sharedResults = []; Ghostd.resultsError = "";
    }
    function cleanup(): void { Ghostd.retireClientRequests(); Ghostd.requestFactory = null; }
    function test_paneLoadsAndShowsFailure(): void {
        const pane = createTemporaryObject(paneComponent, tc);
        verify(pane !== null);
        pane.refresh();
        compare(tc.requests.length, 1);
        verify(tc.requests[0].url.endsWith("/sessions/c1/results"));
        tc.requests[0].complete(503, { error: { message: "Host unavailable" } });
        verify(Ghostd.resultsError.indexOf("Host unavailable") >= 0);
    }
    function test_staleListCannotEnterAnotherConversation(): void {
        Ghostd.refreshResults();
        Ghostd.currentSessionId = "c2";
        tc.requests[0].complete(200, { results: [{ id: "old", name: "old.txt" }] });
        compare(Ghostd.sharedResults.length, 0);
    }
    function test_removeRefreshesListAndShowsRecovery(): void {
        Ghostd.changeResult("DELETE", "/selected", null);
        compare(tc.requests[0].method, "DELETE");
        tc.requests[0].complete(200, { ok: true });
        verify(Ghostd.resultsStatus.indexOf("Trash") >= 0);
        compare(tc.requests.length, 2);
        tc.requests[1].complete(200, { results: [] });
        compare(Ghostd.sharedResults.length, 0);
    }
}
