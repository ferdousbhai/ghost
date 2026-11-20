import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

TestCase {
    id: tc
    name: "RosterRequests"

    property var requests: []

    function init(): void {
        Ghostd.retire(Ghostd, "listRequest");
        requests = [];
        Ghostd.requestFactory = FakeXhr.factory(tc.requests, /\/api\/ghosts$/);
        Ghostd.apiToken = "test-token";
        Ghostd.ghosts = [{ name: "existing", dir: "/tmp/ghosts/existing" }];
        Ghostd.activeGhost = "";
        Ghostd.lastError = "";
    }

    function cleanup(): void {
        Ghostd.retire(Ghostd, "listRequest");
        Ghostd.requestFactory = null;
        requests = [];
    }

    function test_newerListRetiresAndIgnoresOlderCompletion(): void {
        Ghostd.refresh();
        const older = requests[0];
        Ghostd.refresh();
        const newer = requests[1];

        compare(older.abortCount, 1);
        compare(Ghostd.listRequest, newer);
        older.complete(200, [{ name: "stale" }]);
        compare(Ghostd.ghosts[0].name, "existing");

        newer.complete(200, []);
        compare(Ghostd.ghosts.length, 0);
        compare(Ghostd.listRequest, null);
    }

    // A ghost home the owner moved away leaves the listing:
    // the HUD moves to a listed one rather than keep showing it and polling
    // its missing event stream.
    function test_aListingWithoutTheActiveGhostMovesToAListedOne(): void {
        Ghostd.activeGhost = "banished";
        Ghostd.sessionIds = ({ banished: "hud-gone" });
        Ghostd.currentSessionId = "hud-gone";

        Ghostd.refresh();
        requests[0].complete(200, [{ name: "existing", dir: "/tmp/ghosts/existing" }]);

        compare(Ghostd.activeGhost, "existing");
        compare(Ghostd.currentSessionId, "");
        verify(!("banished" in Ghostd.sessionIds));
        Ghostd.activeGhost = "";
    }
}
