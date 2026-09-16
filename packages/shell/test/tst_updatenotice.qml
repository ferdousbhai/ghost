import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

// The daemon's release check reaches the HUD through /api/status. This pins
// what Ghostd keeps from that row: a valid update, or nothing.
TestCase {
    id: tc
    name: "UpdateNotice"

    property var requests: []

    function init(): void {
        tc.requests = [];
        Ghostd.updateAvailable = null;
        Ghostd.statusRequest = null;
        Ghostd.statusRequestFactory = function () { return FakeXhr.make(tc.requests); };
        Ghostd.apiToken = "test-token";
    }

    function cleanup(): void {
        Ghostd.statusRequestFactory = null;
        Ghostd.updateAvailable = null;
    }

    function test_aNewerReleaseIsKeptWithItsCommand(): void {
        Ghostd.fetchDaemonStatus();
        compare(tc.requests.length, 1);
        compare(tc.requests[0].method, "GET");
        verify(tc.requests[0].url.endsWith("/api/status"));
        tc.requests[0].complete(200, {
            version: "0.2.0", source: { commit: null, root: null },
            update: { latest: "0.3.0", command: "omarchy-update", url: "https://example.invalid" }
        });
        compare(Ghostd.updateAvailable.latest, "0.3.0");
        compare(Ghostd.updateAvailable.command, "omarchy-update");
    }

    function test_noUpdateAndAMalformedOneBothClearTheNotice(): void {
        Ghostd.updateAvailable = ({ latest: "9.9.9", command: "x" });
        Ghostd.fetchDaemonStatus();
        tc.requests[0].complete(200, { version: "0.2.0", update: null });
        compare(Ghostd.updateAvailable, null);

        Ghostd.updateAvailable = ({ latest: "9.9.9", command: "x" });
        Ghostd.fetchDaemonStatus();
        tc.requests[1].complete(200, { version: "0.2.0", update: { latest: 3 } });
        compare(Ghostd.updateAvailable, null);
    }

    function test_anOldDaemonWithoutTheRouteChangesNothing(): void {
        Ghostd.updateAvailable = ({ latest: "0.3.0", command: "omarchy-update" });
        Ghostd.fetchDaemonStatus();
        tc.requests[0].complete(404, { error: { code: "not_found", message: "Not found." } });
        compare(Ghostd.updateAvailable.latest, "0.3.0");
    }
}
