import QtQuick
import QtTest
import "../qml/components/McpConfig.js" as Mcp

TestCase {
    name: "McpConfig"

    readonly property var localServer: ({
        name: "local",
        enabled: false,
        config: {
            type: "stdio",
            command: "mcp-local",
            args: ["--port", "9000"],
            env: { API_TOKEN: "secret" },
            cwd: "packages/local-server",
            enabled: false
        }
    })
    readonly property var remoteServer: ({
        name: "remote",
        enabled: true,
        config: {
            type: "http",
            url: "https://example.com/mcp?token=abc",
            headers: { Authorization: "Bearer abc" },
            headerPolicy: "origin-locked"
        }
    })

    function test_editingStartsFromTheStoredConfiguration(): void {
        compare(JSON.parse(Mcp.template(localServer, "stdio")), localServer.config);
        compare(JSON.parse(Mcp.template(remoteServer, "http")), remoteServer.config);
        compare(JSON.parse(Mcp.template(remoteServer, "sse")).type, "sse");
        compare(JSON.parse(Mcp.template(null, "stdio")).command, "npx");
    }

    function test_checksJsonAndTheSelectedTransportOnly(): void {
        verify(Mcp.parse('{"type":"stdio","command":"node"}', "stdio").ok);
        verify(Mcp.parse('{"command":"node"}', "stdio").ok);
        verify(Mcp.parse('{"type":"http","url":"https://example.com/mcp"}', "http").ok);
        // Required fields are the daemon's to refuse, in its own words.
        verify(Mcp.parse('{"type":"http"}', "http").ok);
        verify(!Mcp.parse('{"type":"http","url":"x"}', "sse").ok);
        verify(!Mcp.parse("[]", "stdio").ok);
    }

    function test_summarizesAndFilters(): void {
        compare(Mcp.summary(localServer), "mcp-local --port 9000");
        compare(Mcp.summary(remoteServer), "https://example.com/mcp?token=abc");
        compare(Mcp.filtered([localServer, remoteServer], "api_token")[0].name, "local");
        compare(Mcp.filtered([localServer, remoteServer], "origin-locked")[0].name, "remote");
        compare(Mcp.filtered([localServer, remoteServer], "missing").length, 0);
    }
}
