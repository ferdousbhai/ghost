import QtQuick
import QtTest
import qs.services
import "../qml/components" as Components

TestCase {
    id: tc
    name: "DocumentsBrowser"

    property var requests: []
    property var contentRequests: []

    Component {
        id: browserComponent
        Components.DocumentsBrowser {
            width: 900
            height: 560
        }
    }

    function requestFor(bucket: var): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            url: "",
            aborted: false,
            onreadystatechange: null,
            open: function (_method, url) { this.url = url; this.readyState = 1; },
            setRequestHeader: function () {},
            send: function () {},
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                this.status = 0;
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        bucket.push(xhr);
        return xhr;
    }

    function fakeRequest(): var {
        return tc.requestFor(requests);
    }

    function fakeContentRequest(): var {
        return tc.requestFor(contentRequests);
    }

    function page(path: string, entries: var, query: var, overrides: var): var {
        const rows = entries.map(function (entry) {
            return Object.assign({ modifiedAt: "2026-08-26T10:00:00.000Z" }, entry);
        });
        const files = rows.filter(function (entry) { return entry.kind === "file"; }).length;
        return Object.assign({
            root: "/tmp/test-documents",
            path: path,
            query: query || "",
            entries: rows,
            total: rows.length,
            fileCount: files,
            directoryCount: rows.length - files,
            nextCursor: null,
            truncated: false,
            skipped: []
        }, overrides || {});
    }

    function init(): void {
        // Ghostd's singleton starts a native roster request on construction.
        // Retire its ownership so an eventual status-0 callback cannot reset
        // the deterministic Documents connection used by this component test.
        const roster = Ghostd.listRequest;
        Ghostd.listRequest = null;
        if (roster && roster.readyState !== 4) roster.abort();
        Ghostd.establishedConnection = false;
        Ghostd.reachable = false;
        // A successful fake Documents response establishes daemon reachability.
        // Keep that transition from starting the independent real Hooks request
        // against test port 0 and invalidating this fixture's connection epoch.
        Ghostd.retireHooksRequest();
        Ghostd.hooksLoaded = true;
        Ghostd.documentsEpoch = 0;
        Ghostd.documentDirectories = ({});
        Ghostd.documentRequests = ({});
        Ghostd.documentsRoot = "";
        Ghostd.documentRequestFactory = function () { return tc.fakeRequest(); };
        Ghostd.documentContentRequestFactory = function () { return tc.fakeContentRequest(); };
        Ghostd.clearDocumentContent();
        Ghostd.apiToken = "test-token";
        requests = [];
        contentRequests = [];
    }

    function cleanup(): void {
        Ghostd.documentRequestFactory = null;
        Ghostd.documentContentRequestFactory = null;
        Ghostd.retireHooksRequest();
        Ghostd.hooksLoaded = false;
        Ghostd.documentRequests = ({});
        Ghostd.clearDocumentContent();
        Ghostd.establishedConnection = false;
        Ghostd.reachable = false;
    }

    function test_adaptsFromThreePanesToReversibleStack(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        compare(requests.length, 1);
        requests[0].complete(200, page("", [
            { name: "Projects", path: "Projects", kind: "directory" },
            { name: "welcome.pdf", path: "welcome.pdf", kind: "file", size: 40 }
        ]));
        wait(0);
        verify(browser.wide);
        compare(browser.visibleFolderCount, 2);
        compare(browser.visibleEntryCount, 1);

        browser.width = 568;
        wait(0);
        verify(!browser.wide);
        compare(browser.compactStage, "files");
        browser.compactStage = "folders";
        browser.chooseFolder("Projects", true);
        compare(browser.compactStage, "files");
        compare(requests.length, 2);
        requests[1].complete(200, page("Projects", [
            { name: "brief.pdf", path: "Projects/brief.pdf", kind: "file", size: 80 }
        ]));
        wait(0);
        compare(browser.selectedPath, "Projects/brief.pdf");
        browser.chooseEntry(browser.selectedEntry);
        compare(browser.compactStage, "detail");
        browser.compactStage = "files";
        compare(browser.selectedPath, "Projects/brief.pdf");
    }

    function test_directorySelectionAndSearchAreRememberedIndependently(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        requests[0].complete(200, page("", [
            { name: "Projects", path: "Projects", kind: "directory" },
            { name: "root.pdf", path: "root.pdf", kind: "file" }
        ]));
        wait(0);
        compare(browser.selectedPath, "root.pdf");

        browser.chooseFolder("Projects", false);
        requests[1].complete(200, page("Projects", [
            { name: "plan.pdf", path: "Projects/plan.pdf", kind: "file" },
            { name: "report.pdf", path: "Projects/report.pdf", kind: "file" }
        ]));
        wait(0);
        browser.setSelection("Projects/report.pdf");
        compare(browser.selectedPath, "Projects/report.pdf");

        browser.searchText = "plan";
        wait(220);
        compare(requests.length, 3);
        verify(requests[2].url.indexOf("path=Projects&q=plan") >= 0);
        requests[2].complete(200, page("Projects", [
            { name: "plan.pdf", path: "Projects/plan.pdf", kind: "file" }
        ], "plan"));
        wait(0);
        compare(browser.selectedPath, "Projects/plan.pdf");

        browser.searchText = "";
        wait(0);
        compare(browser.selectedPath, "Projects/report.pdf");
        browser.chooseFolder("", false);
        wait(0);
        compare(browser.selectedPath, "root.pdf");
    }

    function test_findShortcutFocusesCurrentFolderSearch(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        browser.forceActiveFocus();
        verify(browser.activeFocus);
        keyClick(Qt.Key_F, Qt.ControlModifier);
        tryCompare(browser, "searchFocused", true);
    }

    function test_folderOnlyFirstPageExplainsAndLoadsLaterFiles(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        requests[0].complete(200, page("", [
            { name: "A", path: "A", kind: "directory" },
            { name: "B", path: "B", kind: "directory" }
        ], "", { total: 3, directoryCount: 2, fileCount: 1,
            nextCursor: "later", truncated: true }));
        wait(0);
        compare(browser.visibleEntryCount, 0);
        const emptyBody = findChild(browser, "documentsEmptyBody");
        verify(emptyBody !== null);
        verify(emptyBody.text.indexOf("later pages") >= 0);
        verify(emptyBody.text.indexOf("Load more") >= 0);

        Ghostd.loadMoreDocuments("", "");
        compare(requests.length, 2);
        requests[1].complete(200, page("", [
            { name: "later.md", path: "later.md", kind: "file", size: 12 }
        ], "", { total: 3, directoryCount: 2, fileCount: 1,
            truncated: true }));
        wait(0);
        compare(browser.visibleEntryCount, 1);
        compare(browser.selectedPath, "later.md");
    }

    function test_oversizedFileNeverInstantiatesInlinePaneAtBoundary(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        const limit = 1048576;
        requests[0].complete(200, page("", [
            { name: "a-too-large.md", path: "a-too-large.md", kind: "file",
                size: limit + 1 },
            { name: "b-at-limit.md", path: "b-at-limit.md", kind: "file",
                size: limit },
            { name: "c-size-unavailable.md", path: "c-size-unavailable.md", kind: "file" },
            { name: "d-small.md", path: "d-small.md", kind: "file", size: 4 }
        ]));
        wait(0);

        compare(browser.selectedPath, "a-too-large.md");
        verify(browser.selectedTooLarge);
        verify(!browser.selectedOpenable);
        verify(!browser.inlineEditorLoaded);
        const reason = findChild(browser, "documentsInlineUnavailableReason");
        verify(reason !== null);
        verify(reason.text.indexOf("Too large") >= 0);

        browser.chooseEntry(browser.entries[1]);
        tryCompare(browser, "selectedPath", "b-at-limit.md");
        verify(browser.selectedInlineSizeAllowed);
        verify(browser.selectedSizeKnown);
        verify(browser.selectedTypeSupported);
        verify(browser.selectedContentEligible);
        compare(Ghostd.documentsRoot, "/tmp/test-documents");
        wait(0);
        compare(contentRequests.length, 1);
        verify(!browser.selectedOpenable);

        // The exact limit is admitted and requested, but this visual test does
        // not ask Qt's text renderer to lay out a 1 MiB paragraph. Exercise the
        // returned-content pane with a small, byte-exact response instead.
        browser.chooseEntry(browser.entries[3]);
        tryCompare(browser, "selectedPath", "d-small.md");
        wait(0);
        compare(contentRequests.length, 2);
        verify(contentRequests[0].aborted);
        contentRequests[1].complete(200, {
            root: "/tmp/test-documents",
            path: "d-small.md",
            size: 4,
            modifiedAt: "2026-08-26T10:00:00.000Z",
            content: "text"
        });
        tryCompare(browser, "selectedOpenable", true);
        tryCompare(browser, "inlineEditorLoaded", true);
        verify(findChild(browser, "documentsInlineContentView") !== null);

        browser.chooseEntry(browser.entries[2]);
        tryCompare(browser, "selectedPath", "c-size-unavailable.md");
        verify(!browser.selectedOpenable);
        tryCompare(browser, "inlineEditorLoaded", false);
        verify(reason.text.indexOf("Size unavailable") >= 0);
    }
}
