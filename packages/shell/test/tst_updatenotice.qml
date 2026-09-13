import QtQuick
import QtTest
import "../qml/services"

// The daemon's release check reaches the HUD through /api/status. This pins
// what Ghostd keeps from that row: a valid update, or nothing.
TestCase {
    id: tc
    name: "UpdateNotice"

    property var requests: []

    function fakeRequest(): var {
        const xhr = {
            readyState: 0, status: 0, responseText: "", method: "", url: "",
            headers: ({}), onreadystatechange: null,
            open: function (method, url) { this.method = method; this.url = url; this.readyState = 1; },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
            send: function () {},
            abort: function () { this.readyState = 4; this.status = 0; if (this.onreadystatechange) this.onreadystatechange(); },
            complete: function (status, body) {
                this.status = status;
                this.responseText = JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        tc.requests.push(xhr);
        return xhr;
    }

    function init(): void {
        tc.requests = [];
        Ghostd.updateAvailable = null;
        Ghostd.statusRequest = null;
        Ghostd.statusRequestFactory = function () { return tc.fakeRequest(); };
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
