import QtQuick
import QtTest
import "../qml/components/ContextDelete.js" as ContextDelete

TestCase {
    name: "ContextDelete"

    readonly property var docs: [
        { path: "docs/a.md", relativePath: "a.md", title: "A" },
        { path: "docs/b.md", relativePath: "b.md", title: "B" },
        { path: "docs/c.md", relativePath: "c.md", title: "C" }
    ]

    function test_targetsOnlyDocsAndMemory(): void {
        compare(ContextDelete.target("docs", docs[0]).path, "docs/a.md");
        compare(ContextDelete.target("memory", {
            path: "memory/fact.md", slug: "fact"
        }).title, "fact");
        verify(ContextDelete.target("character", { path: "character.md" }) === null);
        verify(ContextDelete.target("agents", { path: "agents/task.md" }) === null);
    }

    function test_nextSelectionPrefersFollowingThenPrevious(): void {
        compare(ContextDelete.nextValue(docs, "docs/b.md", "path"), "docs/c.md");
        compare(ContextDelete.nextValue(docs, "docs/c.md", "path"), "docs/b.md");
        compare(ContextDelete.nextValue([docs[0]], "docs/a.md", "path"), "");
    }

    function test_memoryCanSelectBySlugWhileDeletingByPath(): void {
        const memory = [
            { path: "memory/a.md", slug: "a" },
            { path: "memory/b.md", slug: "b" }
        ];
        compare(ContextDelete.nextValue(memory, "memory/a.md", "slug"), "b");
    }
}
