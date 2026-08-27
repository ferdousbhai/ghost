import QtQuick
import QtTest
import qs.services

TestCase {
    name: "DocumentsLifecycle"

    property var requests: []
    property var deleteRequests: []
    property var contentRequests: []

    function fakeRequest(bucket: var): var {
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
            send: function (body) { this.body = body; },
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                this.status = 0;
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (typeof this.onreadystatechange === "function") this.onreadystatechange();
            }
        };
        bucket.push(xhr);
        return xhr;
    }

    function page(path: string, entries: var, options: var): var {
        const rows = entries.map(function (entry) {
            return Object.assign({ modifiedAt: "2026-08-26T10:00:00.000Z" }, entry);
        });
        let files = 0;
        let directories = 0;
        for (const entry of rows) {
            if (entry.kind === "file") files += 1;
            else directories += 1;
        }
        return Object.assign({
            root: "/home/owner/Documents",
            path: path,
            query: "",
            entries: rows,
            total: files + directories,
            fileCount: files,
            directoryCount: directories,
            nextCursor: null,
            truncated: false,
            skipped: []
        }, options || {});
    }

    function init(): void {
        const roster = Ghostd.listRequest;
        Ghostd.listRequest = null;
        if (roster && roster.readyState !== 4) roster.abort();
        for (const key of Object.keys(Ghostd.documentRequests)) {
            const request = Ghostd.documentRequests[key];
            if (request && request.readyState !== 4) request.abort();
        }
        Ghostd.establishedConnection = false;
        Ghostd.reachable = false;
        // This suite owns only Documents transport. Suppress the independent
        // Hooks fetch which a successful fake request would otherwise trigger.
        Ghostd.retireHooksRequest();
        Ghostd.hooksLoaded = true;
        Ghostd.documentRequests = ({});
        Ghostd.documentDirectories = ({});
        Ghostd.documentsRoot = "";
        Ghostd.documentsEpoch = 0;
        Ghostd.documentDeletingPath = "";
        Ghostd.documentDeleteError = "";
        Ghostd.documentDeleteRequest = null;
        Ghostd.clearDocumentContent();
        Ghostd.apiToken = "test-token";
        requests = [];
        deleteRequests = [];
        contentRequests = [];
        Ghostd.documentRequestFactory = function () { return fakeRequest(requests); };
        Ghostd.documentContentRequestFactory = function () {
            return fakeRequest(contentRequests);
        };
        Ghostd.documentDeleteRequestFactory = function () {
            return fakeRequest(deleteRequests);
        };
    }

    function cleanup(): void {
        Ghostd.documentRequestFactory = null;
        Ghostd.documentContentRequestFactory = null;
        Ghostd.documentDeleteRequestFactory = null;
        Ghostd.retireHooksRequest();
        Ghostd.hooksLoaded = false;
        Ghostd.documentRequests = ({});
        Ghostd.documentDeleteRequest = null;
        Ghostd.clearDocumentContent();
    }

    function test_outOfOrderReplacementCannotPublish(): void {
        // This test isolates replacement ownership, after the epoch's root
        // authority has already been established by its first page.
        Ghostd.documentsRoot = "/home/owner/Documents";
        Ghostd.fetchDocuments("Projects", "", false, false);
        compare(requests.length, 1);
        const stale = requests[0];
        Ghostd.refreshDocuments("Projects", "");
        compare(requests.length, 2);
        verify(stale.aborted);
        const current = requests[1];

        stale.complete(200, page("Projects", [
            { name: "stale.md", path: "Projects/stale.md", kind: "file" }
        ]));
        compare(Ghostd.documentSnapshot("Projects", "").entries.length, 0);

        current.complete(200, page("Projects", [
            { name: "current.md", path: "Projects/current.md", kind: "file" }
        ]));
        compare(Ghostd.documentSnapshot("Projects", "").entries[0].name, "current.md");
    }

    function test_pagesAreRetainedAndCursorStaleIsScoped(): void {
        Ghostd.fetchDocuments("", "", false, false);
        verify(requests[0].url.indexOf("path=&q=&limit=100") >= 0);
        requests[0].complete(200, page("", [
            { name: "a.md", path: "a.md", kind: "file" }
        ], { total: 2, fileCount: 2, nextCursor: "opaque cursor", truncated: true }));
        Ghostd.loadMoreDocuments("", "");
        compare(requests.length, 2);
        verify(requests[1].url.indexOf("cursor=opaque%20cursor") >= 0);
        requests[1].complete(409, {
            error: { code: "cursor_stale", message: "changed" }
        });
        const state = Ghostd.documentSnapshot("", "");
        compare(state.entries.length, 1);
        verify(state.cursorStale);
        verify(state.error.indexOf("changed while") >= 0);
    }

    function test_ghostSwitchDoesNotResetSharedDocuments(): void {
        Ghostd.fetchDocuments("", "", false, false);
        requests[0].complete(200, page("", [
            { name: "shared.md", path: "shared.md", kind: "file" }
        ]));
        Ghostd.activeGhost = "casper";
        Ghostd.activeGhost = "another";
        compare(Ghostd.documentsRoot, "/home/owner/Documents");
        compare(Ghostd.documentSnapshot("", "").entries[0].path, "shared.md");
    }

    function test_queryIsBoundToItsOwnCacheAndEncoded(): void {
        Ghostd.documentsRoot = "/home/owner/Documents";
        Ghostd.fetchDocuments("Project Notes", "  PLAN  ", false, false);
        compare(requests.length, 1);
        verify(requests[0].url.indexOf("path=Project%20Notes&q=plan") >= 0);
        requests[0].complete(200, page("Project Notes", [
            { name: "plan.md", path: "Project Notes/plan.md", kind: "file" }
        ], { query: "plan" }));
        compare(Ghostd.documentSnapshot("Project Notes", "plan").total, 1);
        verify(!Ghostd.documentSnapshot("Project Notes", "").loaded);
    }

    function test_deleteIsConfirmedAndRemovesCachedRowsBeforeRefresh(): void {
        Ghostd.fetchDocuments("", "", false, false);
        requests[0].complete(200, page("", [
            { name: "keep.md", path: "keep.md", kind: "file" },
            { name: "remove.md", path: "remove.md", kind: "file" }
        ]));
        Ghostd.deleteDocument("remove.md");
        compare(deleteRequests.length, 1);
        compare(deleteRequests[0].method, "DELETE");
        compare(deleteRequests[0].body,
            JSON.stringify({ path: "remove.md", confirm: "remove.md" }));
        deleteRequests[0].complete(200, {
            ok: true, path: "remove.md", trash: "/trash/remove.md", kind: "freedesktop"
        });
        compare(Ghostd.documentSnapshot("", "").entries.length, 1);
        compare(Ghostd.documentSnapshot("", "").entries[0].path, "keep.md");
        compare(requests.length, 2); // parent refresh
    }

    function test_fallbackDeleteRemovesEveryCachedCopyAndRefreshesParent(): void {
        Ghostd.fetchDocuments("", "", false, false);
        requests[0].complete(200, page("", [
            { name: "keep.md", path: "keep.md", kind: "file" },
            { name: "remove.md", path: "remove.md", kind: "file" }
        ]));
        Ghostd.fetchDocuments("", "remove", false, false);
        requests[1].complete(200, page("", [
            { name: "remove.md", path: "remove.md", kind: "file" }
        ], { query: "remove" }));

        Ghostd.deleteDocument("remove.md");
        deleteRequests[0].complete(200, {
            ok: true, path: "remove.md", trash: "/Documents/.trash/remove.md",
            kind: "fallback"
        });

        compare(Ghostd.documentSnapshot("", "").entries.length, 1);
        compare(Ghostd.documentSnapshot("", "").entries[0].path, "keep.md");
        compare(Ghostd.documentSnapshot("", "remove").entries.length, 0);
        compare(requests.length, 3);
        verify(requests[2].url.indexOf("path=&q=&limit=100") >= 0);
    }

    function test_deleteRejectsMissingInventedAndMalformedKindWithoutChangingCache(): void {
        Ghostd.fetchDocuments("", "", false, false);
        requests[0].complete(200, page("", [
            { name: "keep.md", path: "keep.md", kind: "file" }
        ]));

        Ghostd.deleteDocument("keep.md");
        deleteRequests[0].complete(200, {
            ok: true, path: "keep.md", trash: "/trash/keep.md"
        });
        verify(Ghostd.documentDeleteError.indexOf("malformed") >= 0);
        compare(Ghostd.documentSnapshot("", "").entries.length, 1);
        compare(requests.length, 1);

        Ghostd.deleteDocument("keep.md");
        deleteRequests[1].complete(200, {
            ok: true, path: "keep.md", trash: "/trash/keep.md", kind: "file"
        });
        verify(Ghostd.documentDeleteError.indexOf("malformed") >= 0);
        compare(Ghostd.documentSnapshot("", "").entries.length, 1);
        compare(requests.length, 1);

        Ghostd.deleteDocument("keep.md");
        deleteRequests[2].complete(200, {
            ok: true, path: "keep.md", trash: "relative/keep.md", kind: "freedesktop"
        });
        verify(Ghostd.documentDeleteError.indexOf("malformed") >= 0);
        compare(Ghostd.documentSnapshot("", "").entries.length, 1);
        compare(requests.length, 1);

        Ghostd.deleteDocument("keep.md");
        deleteRequests[3].complete(200, {
            ok: true, path: "keep.md", trash: "/trash/keep.md", kind: "freedesktop",
            compatibility: true
        });
        verify(Ghostd.documentDeleteError.indexOf("malformed") >= 0);
        compare(Ghostd.documentSnapshot("", "").entries.length, 1);
        compare(requests.length, 1);
    }

    function test_contentRejectsCompatibilityFields(): void {
        Ghostd.documentsRoot = "/home/owner/Documents";
        Ghostd.fetchDocumentContent("keep.md", false);
        contentRequests[0].complete(200, {
            root: "/home/owner/Documents",
            path: "keep.md",
            size: 4,
            modifiedAt: "2026-08-26T10:00:00.000Z",
            content: "text",
            href: "file:///home/owner/Documents/keep.md"
        });
        verify(!Ghostd.documentContentReady);
        verify(Ghostd.documentContentError.indexOf("malformed") >= 0);
    }

    function test_deleteHttpFailurePreservesCacheAndDoesNotRefresh(): void {
        Ghostd.fetchDocuments("", "", false, false);
        requests[0].complete(200, page("", [
            { name: "keep.md", path: "keep.md", kind: "file" }
        ]));
        Ghostd.deleteDocument("keep.md");
        deleteRequests[0].complete(500, {
            error: { code: "internal_error", message: "trash unavailable" }
        });

        verify(Ghostd.documentDeleteError.indexOf("trash unavailable") >= 0);
        compare(Ghostd.documentDeletingPath, "");
        compare(Ghostd.documentSnapshot("", "").entries.length, 1);
        compare(requests.length, 1);
    }

    function test_startupOfflineRetiresLoadingAndReconnectsFromFreshRootPage(): void {
        verify(!Ghostd.reachable);
        verify(!Ghostd.establishedConnection);
        Ghostd.fetchDocuments("", "", false, false);
        const offline = requests[0];
        verify(Ghostd.documentSnapshot("", "").loading);

        offline.complete(0, "");
        compare(Ghostd.documentsEpoch, 1);
        verify(!Ghostd.documentSnapshot("", "").loading);
        compare(Object.keys(Ghostd.documentRequests).length, 0);

        Ghostd.reachable = true;
        wait(0);
        compare(requests.length, 2);
        requests[1].complete(200, page("", [
            { name: "reconnected.md", path: "reconnected.md", kind: "file" }
        ], { root: "/mnt/reconnected/Documents" }));
        compare(Ghostd.documentsRoot, "/mnt/reconnected/Documents");
        compare(Ghostd.documentSnapshot("", "").entries[0].path, "reconnected.md");
    }

    function test_statusZeroRetiresSiblingRequestsAndStaleCallbacks(): void {
        Ghostd.documentsRoot = "/home/owner/Documents";
        Ghostd.fetchDocuments("Projects", "", false, false);
        const failed = requests[0];
        Ghostd.fetchDocumentContent("old.md", false);
        const staleContent = contentRequests[0];

        failed.complete(0, "");
        compare(Ghostd.documentsEpoch, 1);
        verify(staleContent.aborted);
        compare(Ghostd.documentsRoot, "");
        verify(!Ghostd.documentSnapshot("Projects", "").loading);

        staleContent.complete(200, {
            root: "/home/owner/Documents",
            path: "old.md",
            size: 3,
            modifiedAt: "2026-08-26T10:00:00.000Z",
            content: "old"
        });
        verify(!Ghostd.documentContentReady);
        compare(Ghostd.documentContentPath, "");
    }

    function test_contentAndDeleteStatusZeroEachRetireTheirEpoch(): void {
        Ghostd.documentsRoot = "/home/owner/Documents";
        Ghostd.fetchDocumentContent("offline.md", false);
        verify(Ghostd.documentContentLoading);
        contentRequests[0].complete(0, "");
        compare(Ghostd.documentsEpoch, 1);
        verify(!Ghostd.documentContentLoading);
        compare(Ghostd.documentContentPath, "");

        Ghostd.documentsRoot = "/home/owner/Documents";
        Ghostd.deleteDocument("offline.md");
        compare(Ghostd.documentDeletingPath, "offline.md");
        deleteRequests[0].complete(0, "");
        compare(Ghostd.documentsEpoch, 2);
        compare(Ghostd.documentDeletingPath, "");
        compare(Ghostd.documentDeleteRequest, null);
    }

    function test_reconnectEpochRejectsOldCallbacksAndChangesRootOnlyFromFreshRootPage(): void {
        Ghostd.fetchDocuments("", "", false, false);
        requests[0].complete(200, page("", [
            { name: "Projects", path: "Projects", kind: "directory" }
        ]));
        compare(Ghostd.documentsRoot, "/home/owner/Documents");
        verify(Ghostd.reachable);

        Ghostd.fetchDocumentContent("old.md", false);
        compare(contentRequests.length, 1);
        const staleContent = contentRequests[0];
        Ghostd.fetchDocuments("Projects", "", false, false);
        const staleNested = requests[1];
        compare(Ghostd.documentsEpoch, 0);
        Ghostd.reachable = false;
        compare(Ghostd.documentsEpoch, 1);
        verify(staleNested.aborted);
        verify(staleContent.aborted);
        compare(Ghostd.documentsRoot, "");
        compare(Ghostd.documentContentPath, "");
        verify(!Ghostd.documentSnapshot("", "").loaded);

        // A deep request cannot establish a new daemon's Documents root. It is
        // converted into a fresh root-page request for the new epoch.
        Ghostd.fetchDocuments("Projects", "", false, true);
        compare(requests.length, 3);
        verify(requests[2].url.indexOf("path=&q=&limit=100") >= 0);
        const newRoot = page("", [
            { name: "New", path: "New", kind: "directory" }
        ], { root: "/mnt/owner/New Documents" });
        requests[2].complete(200, newRoot);
        compare(Ghostd.documentsRoot, "/mnt/owner/New Documents");
        verify(Ghostd.reachable);

        staleNested.complete(200, page("Projects", [
            { name: "stale.md", path: "Projects/stale.md", kind: "file" }
        ]));
        staleContent.complete(200, {
            root: "/home/owner/Documents",
            path: "old.md",
            size: 3,
            modifiedAt: "2026-08-26T10:00:00.000Z",
            content: "old"
        });
        compare(Ghostd.documentsRoot, "/mnt/owner/New Documents");
        verify(!Ghostd.documentContentReady);
        verify(!Ghostd.documentSnapshot("Projects", "").loaded);
        compare(Ghostd.documentSnapshot("", "").entries[0].path, "New");
    }
}
