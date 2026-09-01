import QtQuick
import QtTest
import qs.components
import qs.services

// character.md editing goes through the daemon (GET|PUT /character), never a
// direct disk write. The daemon owns the size cap: the shell renders the
// echoed limit and surfaces a refused save without losing the draft.
TestCase {
    id: tc
    name: "CharacterPane"

    property var requests: []

    SignalSpy {
        id: writeSpy
        target: Ghostd
        signalName: "characterWriteFinished"
    }

    Component {
        id: paneComponent
        CharacterPane {
            width: 700
            height: 400
        }
    }

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
            send: function (payload) {
                this.body = payload === undefined ? null : payload;
            },
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                this.status = 0;
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            },
            complete: function (status, responseBody) {
                this.status = status;
                this.responseText = typeof responseBody === "string"
                    ? responseBody : JSON.stringify(responseBody);
                this.readyState = 4;
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            }
        };
        tc.requests.push(xhr);
        return xhr;
    }

    function init(): void {
        Ghostd.clearCharacter();
        Ghostd.activeGhost = "casper";
        Ghostd.apiToken = "test-token";
        requests = [];
        writeSpy.clear();
        Ghostd.characterRequestFactory = function () { return tc.fakeRequest(); };
    }

    function cleanup(): void {
        Ghostd.characterRequestFactory = null;
        Ghostd.clearCharacter();
        Ghostd.activeGhost = "";
    }

    function loadedPane(body: string): var {
        Ghostd.fetchCharacter(false);
        requests[0].complete(200, { body: body, title: null, limit: 20000 });
        const pane = createTemporaryObject(paneComponent, tc);
        verify(pane !== null);
        return pane;
    }

    function test_fetchAppliesBodyTitleAndDaemonLimit(): void {
        Ghostd.fetchCharacter(false);
        compare(requests.length, 1);
        compare(requests[0].method, "GET");
        verify(requests[0].url.endsWith("/ghosts/casper/character"));
        verify(Ghostd.characterLoading);
        requests[0].complete(200, {
            body: "# Casper\n\nKind and curious.",
            title: "Casper",
            limit: 20000
        });

        verify(!Ghostd.characterLoading);
        compare(Ghostd.characterBody, "# Casper\n\nKind and curious.");
        compare(Ghostd.characterTitle, "Casper");
        compare(Ghostd.characterLimit, 20000);
        compare(Ghostd.characterGhost, "casper");
        compare(Ghostd.characterError, "");

        // The per-ghost cache holds: a second unforced fetch sends nothing.
        Ghostd.fetchCharacter(false);
        compare(requests.length, 1);
    }

    function test_staleMismatchedGhostResponseIsDropped(): void {
        Ghostd.fetchCharacter(false);
        const stale = requests[0];
        Ghostd.activeGhost = "mina";
        stale.complete(200, { body: "Casper's persona.", title: null, limit: 20000 });

        verify(!Ghostd.characterLoading);
        compare(Ghostd.characterBody, "");
        compare(Ghostd.characterGhost, "");
        compare(Ghostd.characterLimit, 0);
    }

    function test_limitExceededWriteSurfacesErrorAndKeepsDraft(): void {
        const pane = loadedPane("Short persona.");
        compare(pane.draftText, "Short persona.");
        pane.draftText = "Short persona. Plus far too much detail.";
        pane.save();

        compare(requests.length, 2);
        compare(requests[1].method, "PUT");
        verify(requests[1].url.endsWith("/ghosts/casper/character"));
        compare(JSON.parse(requests[1].body),
            { body: "Short persona. Plus far too much detail." });
        verify(Ghostd.characterSaving);
        requests[1].complete(400, {
            error: {
                code: "limit_exceeded",
                message: "character.md is limited to 20000 characters."
            }
        });

        verify(!Ghostd.characterSaving);
        verify(Ghostd.characterError.indexOf(
            "character.md is limited to 20000 characters.") >= 0);
        compare(writeSpy.count, 1);
        compare(writeSpy.signalArguments[0][0], false);
        // The draft survives the refusal, over the daemon's reason.
        compare(pane.draftText, "Short persona. Plus far too much detail.");
        verify(pane.dirty);
        compare(Ghostd.characterBody, "Short persona.");
        compare(requests.length, 2); // no re-read after a refused write
    }

    function test_successfulSaveUpdatesStateAndRereadsForTitle(): void {
        const pane = loadedPane("# Old\n\nBody.");
        pane.draftText = "# New\n\nBody.";
        pane.save();
        compare(requests.length, 2);
        requests[1].complete(200, { ok: true, limit: 20000 });

        verify(!Ghostd.characterSaving);
        compare(Ghostd.characterBody, "# New\n\nBody.");
        compare(Ghostd.characterError, "");
        compare(writeSpy.count, 1);
        compare(writeSpy.signalArguments[0][0], true);
        verify(!pane.dirty);

        // The disk is the truth: a forced re-read follows for the derived title.
        compare(requests.length, 3);
        compare(requests[2].method, "GET");
        requests[2].complete(200, { body: "# New\n\nBody.", title: "New", limit: 20000 });
        compare(Ghostd.characterTitle, "New");
        compare(pane.draftText, "# New\n\nBody.");
    }
}
