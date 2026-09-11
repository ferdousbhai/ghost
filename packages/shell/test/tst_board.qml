import QtQuick
import QtTest
import qs.services

// The board pane's service side: what the HUD makes of GET /api/board.
TestCase {
    id: tc
    name: "Board"

    property var requests: []

    function fakeRequest(): var {
        const xhr = {
            readyState: 0, status: 0, responseText: "", method: "", url: "", body: null,
            headers: ({}), onreadystatechange: null,
            open: function (method, url) { this.method = method; this.url = url; this.readyState = 1; },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
            send: function (body) { this.body = body; },
            abort: function () { this.readyState = 4; this.status = 0; if (this.onreadystatechange) this.onreadystatechange(); },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        tc.requests.push(xhr);
        return xhr;
    }

    function init(): void {
        tc.requests = [];
        Ghostd.boardRequestFactory = tc.fakeRequest;
        Ghostd.board = null;
        Ghostd.boardError = "";
        Ghostd.boardRequest = null;
    }

    function cleanup(): void {
        Ghostd.boardRequestFactory = null;
    }

    function test_parses_a_board_and_rejects_a_malformed_one(): void {
        const board = Ghostd.boardFrom({
            path: "/home/o/Documents/board.md", exists: true, title: "Work", modified: "2026-09-11T10:00:00Z",
            truncated: false,
            columns: [{ title: "Now", cards: [{ text: "ship", done: false, notes: ["a note"] }, { text: "plain", notes: [] }] }]
        });
        compare(board.title, "Work");
        compare(board.columns[0].cards[0].done, false);
        compare(board.columns[0].cards[1].done, null);
        compare(board.columns[0].cards[0].notes, ["a note"]);
        compare(Ghostd.boardFrom({ exists: true }), null);
        compare(Ghostd.boardFrom({ path: "/x", exists: true, columns: [{ title: "T", cards: [{}] }] }), null);
        compare(Ghostd.boardFrom("nope"), null);
    }

    function test_refresh_reads_the_route_and_keeps_the_last_board_on_failure(): void {
        Ghostd.refreshBoard();
        compare(tc.requests.length, 1);
        compare(tc.requests[0].method, "GET");
        verify(tc.requests[0].url.endsWith("/api/board"));
        tc.requests[0].complete(200, { path: "/p/board.md", exists: false, title: null, modified: null, truncated: false, columns: [] });
        compare(Ghostd.board.exists, false);
        compare(Ghostd.boardError, "");

        Ghostd.refreshBoard();
        tc.requests[1].complete(500, { error: { code: "internal", message: "boom" } });
        verify(Ghostd.boardError !== "");
        compare(Ghostd.board.exists, false);

        Ghostd.refreshBoard();
        tc.requests[2].complete(200, "not json");
        compare(Ghostd.boardError, "ghostd sent a malformed board");
    }

    function test_refresh_is_single_flight(): void {
        Ghostd.refreshBoard();
        Ghostd.refreshBoard();
        compare(tc.requests.length, 1);
    }
}
