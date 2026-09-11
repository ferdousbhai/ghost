import QtQuick
import QtTest
import qs.services
import qs.components

// The resources line at the top of a conversation: what it says and when.
TestCase {
    id: tc
    name: "ResourcesLine"
    width: 400
    height: 300

    Component { id: line; ResourcesLine { width: 380 } }

    function cleanup(): void { Ghostd.sessionResources = null; }

    function test_hidden_until_a_snapshot_exists(): void {
        const item = createTemporaryObject(line, tc);
        verify(!item.shown);
        compare(item.height, 0);
        Ghostd.sessionResources = { runtime: "pi", skills: [], mcpServers: [], diagnostics: [], mcpDiagnostics: [] };
        verify(!item.shown);
    }

    function test_counts_admitted_and_calls_out_the_rest(): void {
        const item = createTemporaryObject(line, tc);
        Ghostd.sessionResources = {
            runtime: "pi",
            skills: [
                { name: "research", path: "/g/research", source: "ghost", precedence: 1, status: "admitted" },
                { name: "old", path: "/m/old", source: "machine", precedence: 2, status: "shadowed", shadowedBy: "/g/old" }
            ],
            mcpServers: [
                { name: "fs", path: "/g/mcp.json", source: "ghost", precedence: 1, status: "admitted", enabled: true },
                { name: "oauth", path: "/g/mcp.json", source: "ghost", precedence: 1, status: "skipped", enabled: true, reason: "oauth not supported here" }
            ],
            diagnostics: [{ source: "machine", path: "/m/broken", reason: "no SKILL.md" }],
            mcpDiagnostics: []
        };
        verify(item.shown);
        compare(item.summary(), "1 skill · 1 MCP server");
        compare(item.notAdmitted, 3);
        compare(item.rows.length, 4);
        compare(item.detail(item.rows[1].row), "shadowed by /g/old");
        compare(item.detail(item.rows[3].row), "oauth not supported here");
        verify(item.height > 0);
        const collapsed = item.height;
        item.expanded = true;
        waitForRendering(item);
        verify(item.height > collapsed);
    }
}
