import QtQuick
import QtTest
import "../qml/components/DocumentModel.js" as Documents

TestCase {
    name: "DocumentModel"

    function page(path: string, entries: var, overrides: var): var {
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
        }, overrides || {});
    }

    function test_pagesPreserveDaemonOrderingAcrossPagination(): void {
        let cache = ({});
        const first = Documents.applyPage(cache, "", "", page("", [
            { name: "Folder 2", path: "Folder 2", kind: "directory" },
            { name: "Folder 10", path: "Folder 10", kind: "directory" }
        ], { total: 4, fileCount: 2, directoryCount: 2,
            nextCursor: "next", truncated: true }), false);
        verify(first.ok);
        cache = first.cache;
        compare(Documents.snapshot(cache, "", "").entries.map(function (entry) {
            return entry.path;
        }).join("|"), "Folder 2|Folder 10");

        const second = Documents.applyPage(cache, "", "", page("", [
            { name: "note 2.md", path: "note 2.md", kind: "file" },
            { name: "note 10.md", path: "note 10.md", kind: "file" }
        ], { total: 4, fileCount: 2, directoryCount: 2, truncated: true }), true);
        verify(second.ok);
        compare(second.value.entries.map(function (entry) {
            return entry.path;
        }).join("|"), "Folder 2|Folder 10|note 2.md|note 10.md");
    }

    function test_inlineSizePolicyIsInclusiveAndFailsClosed(): void {
        const limit = Documents.inlineFileMaxBytes();
        compare(limit, 1048576);
        verify(Documents.canReadInline({ kind: "file", size: 0 }));
        verify(Documents.canReadInline({ kind: "file", size: limit }));
        verify(!Documents.canReadInline({ kind: "file", size: limit + 1 }));
        verify(!Documents.canReadInline({ kind: "file" }));
        verify(!Documents.canReadInline({ kind: "file", size: 1.5 }));
        verify(!Documents.canReadInline({ kind: "directory", size: 12 }));
        verify(!Documents.isTooLargeForInline({ kind: "file", size: limit }));
        verify(Documents.isTooLargeForInline({ kind: "file", size: limit + 1 }));
        verify(!Documents.isTooLargeForInline({ kind: "file" }));
    }

    function test_deepTreeHasNoDepthCapAndLoadsOnlyExpandedPaths(): void {
        let cache = ({});
        let path = "";
        const expanded = ({ "": true });
        const depth = 140;
        for (let index = 0; index < depth; index++) {
            const name = "level-" + index;
            const child = path === "" ? name : path + "/" + name;
            const result = Documents.applyPage(cache, path, "", page(path, [
                { name: name, path: child, kind: "directory" }
            ]), false);
            verify(result.ok);
            cache = result.cache;
            expanded[child] = true;
            path = child;
        }
        const rows = Documents.visibleFolders(cache, expanded);
        compare(rows.length, depth + 1);
        compare(rows[rows.length - 1].depth, depth);
        compare(Documents.maxDepth(rows), depth);

        const collapsed = Documents.visibleFolders(cache, ({ "": true }));
        compare(collapsed.length, 2);
    }

    function test_queryKeysAndDirectoryViewsStayIndependent(): void {
        let cache = Documents.applyPage(({}), "Projects", "", page("Projects", [
            { name: "alpha.md", path: "Projects/alpha.md", kind: "file" }
        ]), false).cache;
        cache = Documents.applyPage(cache, "Projects", "ALP", page("Projects", [
            { name: "alpha.md", path: "Projects/alpha.md", kind: "file" }
        ], { query: "alp" }), false).cache;
        compare(Object.keys(cache).length, 2);
        compare(Documents.snapshot(cache, "Projects", "").query, "");
        compare(Documents.snapshot(cache, "Projects", "alp").query, "alp");
    }

    function test_errorAndCursorStalePreserveKnownRows(): void {
        const applied = Documents.applyPage(({}), "", "", page("", [
            { name: "known.md", path: "known.md", kind: "file" }
        ], { total: 2, fileCount: 2, nextCursor: "cursor", truncated: true }), false);
        let cache = Documents.begin(applied.cache, "", "", true);
        cache = Documents.fail(cache, "", "", "Folder changed", true);
        const state = Documents.snapshot(cache, "", "");
        compare(state.entries.length, 1);
        compare(state.entries[0].path, "known.md");
        verify(state.cursorStale);
        verify(!state.loading);
    }

    function test_deleteChoosesFollowingThenPreviousFile(): void {
        const entries = [
            { name: "folder", path: "folder", kind: "directory" },
            { name: "a.md", path: "a.md", kind: "file" },
            { name: "b.md", path: "b.md", kind: "file" },
            { name: "c.md", path: "c.md", kind: "file" }
        ];
        compare(Documents.nextFile(entries, "b.md"), "c.md");
        compare(Documents.nextFile(entries, "c.md"), "b.md");
        compare(Documents.nextFile([entries[1]], "a.md"), "");
    }

    function test_rejects_crossDirectoryAnd_inconsistentPages(): void {
        const crossed = Documents.applyPage(({}), "Projects", "", page("Projects", [
            { name: "escape.md", path: "Elsewhere/escape.md", kind: "file" }
        ]), false);
        verify(!crossed.ok);
        verify(Documents.snapshot(crossed.cache, "Projects", "").error !== "");

        const inconsistent = Documents.applyPage(({}), "", "", page("", [], {
            total: 2, fileCount: 1, directoryCount: 0
        }), false);
        verify(!inconsistent.ok);
    }

    function test_rejectsNonCanonicalPathsAndMalformedMetadata(): void {
        for (const rawPath of ["/Projects", "Projects/", "Projects//Deep",
                "Projects/./Deep", "Projects/../Elsewhere", "Projects\\Deep"]) {
            verify(!Documents.applyPage(({}), rawPath, "", page(rawPath, []), false).ok,
                "accepted non-canonical requested path " + rawPath);
        }

        const malformed = [
            { name: "bad.md", path: "bad.md", kind: "file", modifiedAt: "yesterday" },
            { name: "bad.md", path: "bad.md", kind: "file", size: -1 },
            { name: "bad.md", path: "bad.md", kind: "file", size: 1.5 },
            { name: "folder", path: "folder", kind: "directory", size: 0 },
            { name: "bad.md", path: "Else/../bad.md", kind: "file" }
        ];
        for (const entry of malformed) {
            const body = page("", [entry]);
            // Preserve an explicitly malformed timestamp instead of the helper default.
            if (entry.modifiedAt !== undefined) body.entries[0].modifiedAt = entry.modifiedAt;
            verify(!Documents.applyPage(({}), "", "", body, false).ok,
                "accepted malformed entry " + JSON.stringify(entry));
        }

        const missingModifiedAt = page("", [
            { name: "missing.md", path: "missing.md", kind: "file" }
        ]);
        delete missingModifiedAt.entries[0].modifiedAt;
        verify(!Documents.applyPage(({}), "", "", missingModifiedAt, false).ok,
            "accepted an entry without modifiedAt");

        const badSkipped = page("", [], {
            skipped: [{ name: "link", path: "Other/link", reason: "Not followed" }]
        });
        verify(!Documents.applyPage(({}), "", "", badSkipped, false).ok);
        badSkipped.skipped = [{ name: "link", path: "link", reason: 42 }];
        verify(!Documents.applyPage(({}), "", "", badSkipped, false).ok);
    }

    function test_foldersFirstPagesKeepLaterFilesReachable(): void {
        let cache = Documents.applyPage(({}), "", "", page("", [
            { name: "A", path: "A", kind: "directory" },
            { name: "B", path: "B", kind: "directory" }
        ], { total: 3, directoryCount: 2, fileCount: 1,
            nextCursor: "later", truncated: true }), false).cache;
        const first = Documents.snapshot(cache, "", "");
        compare(first.entries.filter(function (entry) { return entry.kind === "file"; }).length, 0);
        compare(first.nextCursor, "later");

        const second = Documents.applyPage(cache, "", "", page("", [
            { name: "later.md", path: "later.md", kind: "file", size: 12 }
        ], { total: 3, directoryCount: 2, fileCount: 1,
            truncated: true }), true);
        verify(second.ok);
        compare(second.value.entries.length, 3);
        compare(second.value.entries[2].path, "later.md");
    }

    function test_hostileObjectNamesRemainOwnKeysAcrossPagesSkipsAndFolderExpansion(): void {
        let cache = Documents.applyPage(Documents.emptyMap(), "", "", page("", [
            { name: "constructor", path: "constructor", kind: "directory" },
            { name: "toString", path: "toString", kind: "directory" }
        ], { total: 4, directoryCount: 3, fileCount: 1,
            nextCursor: "later", truncated: true,
            skipped: [{ name: "__proto__", path: "__proto__", reason: "first skip" }] }), false).cache;
        const appended = Documents.applyPage(cache, "", "", page("", [
            { name: "__proto__", path: "__proto__", kind: "directory" },
            { name: "constructor.txt", path: "constructor.txt", kind: "file", size: 1 }
        ], { total: 4, directoryCount: 3, fileCount: 1, truncated: true,
            skipped: [
                { name: "__proto__", path: "__proto__", reason: "updated skip" },
                { name: "toString", path: "toString", reason: "second skip" }
            ] }), true);
        verify(appended.ok);
        cache = appended.cache;
        compare(appended.value.entries.map(function (entry) { return entry.path; }).join("|"),
            "constructor|toString|__proto__|constructor.txt");
        compare(appended.value.skipped.length, 2);
        compare(appended.value.skipped.filter(function (item) {
            return item.path === "__proto__";
        })[0].reason, "updated skip");

        for (const folder of ["constructor", "toString", "__proto__"]) {
            const child = folder + "/leaf";
            const result = Documents.applyPage(cache, folder, "", page(folder, [
                { name: "leaf", path: child, kind: "directory" }
            ]), false);
            verify(result.ok);
            cache = result.cache;
        }
        let expanded = Documents.setMapValue(Documents.emptyMap(), "", true);
        for (const folder of ["constructor", "toString", "__proto__"])
            expanded = Documents.setMapValue(expanded, folder, true);
        const rows = Documents.visibleFolders(cache, expanded);
        for (const folder of ["constructor", "toString", "__proto__"]) {
            verify(rows.some(function (row) { return row.path === folder; }),
                "missing hostile folder " + folder);
            verify(rows.some(function (row) { return row.path === folder + "/leaf"; }),
                "did not expand hostile folder " + folder);
        }

        const map = Documents.setMapValue(Documents.emptyMap(), "__proto__", "kept");
        compare(Documents.mapValue(map, "__proto__", "missing"), "kept");
        compare(Documents.mapValue(map, "constructor", "missing"), "missing");
    }

    function test_rejectsNormalizedDatesExtraFieldsDuplicatesAndCountSkew(): void {
        const impossibleDate = page("", [
            { name: "date.md", path: "date.md", kind: "file", size: 1 }
        ]);
        impossibleDate.entries[0].modifiedAt = "2026-02-30T10:00:00.000Z";
        verify(!Documents.applyPage(({}), "", "", impossibleDate, false).ok);

        const extraPage = page("", []);
        extraPage.compatibility = true;
        verify(!Documents.applyPage(({}), "", "", extraPage, false).ok);

        const extraEntry = page("", [
            { name: "extra.md", path: "extra.md", kind: "file", size: 1, href: "file:///tmp" }
        ]);
        verify(!Documents.applyPage(({}), "", "", extraEntry, false).ok);

        const duplicate = page("", [
            { name: "same.md", path: "same.md", kind: "file", size: 1 },
            { name: "same.md", path: "same.md", kind: "file", size: 1 }
        ]);
        verify(!Documents.applyPage(({}), "", "", duplicate, false).ok);

        const first = Documents.applyPage(({}), "", "", page("", [
            { name: "same.md", path: "same.md", kind: "file", size: 1 }
        ], { total: 2, fileCount: 2, nextCursor: "next", truncated: true }), false);
        verify(first.ok);
        const repeated = Documents.applyPage(first.cache, "", "", page("", [
            { name: "same.md", path: "same.md", kind: "file", size: 1 }
        ], { total: 2, fileCount: 2, truncated: true }), true);
        verify(!repeated.ok);

        const skewed = page("", [
            { name: "one.md", path: "one.md", kind: "file", size: 1 },
            { name: "two.md", path: "two.md", kind: "file", size: 1 }
        ], { fileCount: 1, directoryCount: 1 });
        verify(!Documents.applyPage(({}), "", "", skewed, false).ok);
    }
}
