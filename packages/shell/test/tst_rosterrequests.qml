import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

TestCase {
    id: tc
    name: "RosterRequests"

    property var requests: []

    function init(): void {
        Ghostd.retireListRequest();
        Ghostd.retireCreateGhostRequest();
        requests = [];
        Ghostd.ghostRequestFactory = function () { return FakeXhr.make(tc.requests); };
        Ghostd.apiToken = "test-token";
        Ghostd.ghosts = [{ name: "existing", dir: "/tmp/ghosts/existing" }];
        Ghostd.activeGhost = "";
        Ghostd.lastError = "";
    }

    function cleanup(): void {
        Ghostd.retireListRequest();
        Ghostd.retireCreateGhostRequest();
        Ghostd.ghostRequestFactory = null;
        requests = [];
    }

    function test_listAndCreateKeepIndependentOwners(): void {
        Ghostd.refresh();
        compare(requests.length, 1);
        const listing = requests[0];
        const listGeneration = Ghostd.listGeneration;

        Ghostd.createGhost("new-ghost");
        compare(requests.length, 2);
        const create = requests[1];
        compare(Ghostd.listRequest, listing);
        compare(Ghostd.createGhostRequest, create);
        compare(Ghostd.listGeneration, listGeneration);
        compare(listing.method, "GET");
        compare(create.method, "POST");
        compare(JSON.parse(create.body), { name: "new-ghost" });

        listing.complete(200, []);
        compare(Ghostd.listRequest, null);
        compare(Ghostd.createGhostRequest, create);
        create.complete(409, {
            error: { code: "conflict", message: "already exists" }
        });
        compare(Ghostd.createGhostRequest, null);
        verify(Ghostd.lastError.indexOf("already exists") >= 0);
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

    function test_newerCreateRetiresAndIgnoresOlderCompletion(): void {
        Ghostd.createGhost("older");
        const older = requests[0];
        Ghostd.createGhost("newer");
        const newer = requests[1];

        compare(older.abortCount, 1);
        compare(Ghostd.createGhostRequest, newer);
        older.complete(201, { name: "older", dir: "/tmp/ghosts/older" });
        compare(Ghostd.ghosts.length, 1);
        compare(Ghostd.ghosts[0].name, "existing");

        newer.complete(409, {
            error: { code: "conflict", message: "newer conflict" }
        });
        compare(Ghostd.createGhostRequest, null);
        verify(Ghostd.lastError.indexOf("newer conflict") >= 0);
    }
}
