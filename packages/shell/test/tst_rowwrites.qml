import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

// Pin, rename, and question writes to two rows in quick succession: each keeps
// its own callback, so the first one's failure is still undone and reported.
TestCase {
    id: tc
    name: "RowWrites"

    property var requests: []

    function init(): void {
        tc.requests = [];
        Ghostd.requestFactory = FakeXhr.factory(tc.requests, /\/sessions/);
        Ghostd.apiToken = "test-token";
        Ghostd.activeGhost = "casper";
        Ghostd.sessionsError = "";
        Ghostd.sessions = [
            { id: "a", title: "first", pinned: false, updatedAt: "2026-01-02T00:00:00Z", question: { text: "Go?" } },
            { id: "b", title: "second", pinned: false, updatedAt: "2026-01-01T00:00:00Z", question: { text: "Stop?" } }
        ];
    }

    function cleanup(): void {
        Ghostd.retire(Ghostd, "sessionsRequest");
        Ghostd.requestFactory = null;
        Ghostd.sessions = [];
        Ghostd.sessionsError = "";
        tc.requests = [];
    }

    function writes(): var {
        return tc.requests.filter(request => request.method !== "GET");
    }

    function test_aFailedRenameIsUndoneAfterAnotherRowWasRenamed(): void {
        Ghostd.renameConversation("a", "renamed a");
        Ghostd.renameConversation("b", "renamed b");
        compare(writes().length, 2);
        compare(Ghostd.sessionRow("a").title, "renamed a");

        writes()[0].complete(500, { error: { code: "internal", message: "disk full" } });
        compare(Ghostd.sessionRow("a").title, "first");
        verify(Ghostd.sessionsError.indexOf("disk full") >= 0);

        writes()[1].complete(200, { title: "renamed b" });
        compare(Ghostd.sessionRow("b").title, "renamed b");
        compare(Object.keys(Ghostd.rowWrites).length, 0);
    }

    function test_aFailedPinRelistsAfterAnotherRowWasPinned(): void {
        Ghostd.pinConversation("a", true);
        Ghostd.pinConversation("b", true);
        compare(writes().length, 2);

        writes()[1].complete(200, { ok: true, pinned: true });
        writes()[0].complete(500, { error: { code: "internal", message: "no pin" } });
        verify(Ghostd.sessionsError.indexOf("no pin") >= 0);
        // The optimistic order is a lie now: the listing is asked for again.
        const relist = tc.requests.filter(request => request.method === "GET");
        compare(relist.length, 1);
        verify(relist[0].url.endsWith("/api/ghosts/casper/sessions"));
    }

    function test_aFailedDismissRelistsAfterAnotherQuestionWasDismissed(): void {
        Ghostd.dismissQuestion("a");
        Ghostd.dismissQuestion("b");
        compare(Ghostd.sessionRow("a").question, null);

        writes()[0].complete(404, { error: { code: "not_found", message: "gone" } });
        writes()[1].complete(200, { ok: true });
        verify(Ghostd.sessionsError.indexOf("gone") >= 0);
        compare(tc.requests.filter(request => request.method === "GET").length, 1);
    }
}
