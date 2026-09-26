import QtQuick
import QtTest
import "../qml/components/McpConfig.js" as Mcp

TestCase {
    name: "McpConfig"

    readonly property var localServer: ({
        name: "local",
        enabled: false,
        source: "canonical",
        config: {
            type: "stdio",
            command: "mcp-local",
            argumentCount: 2,
            environment: { keys: ["API_TOKEN"], configured: true },
            timeout: 20,
            requestIdFormat: "string",
            cwd: "packages/local-server",
            envPolicy: "literal",
            auth: { type: "apikey", configured: true }
        }
    })
    readonly property var remoteServer: ({
        name: "remote",
        enabled: true,
        source: "legacy",
        config: {
            type: "http",
            url: "https://example.com/mcp?token=%5Bconfigured%5D",
            headers: { keys: ["Authorization"], configured: true },
            headerPolicy: "origin-locked",
            oauth: {
                configured: true,
                clientIdConfigured: true,
                clientSecretConfigured: true
            }
        }
    })

    function test_detectsHiddenValues(): void {
        verify(Mcp.hasHiddenValues(localServer));
        verify(Mcp.hasHiddenValues(remoteServer));
        compare(Mcp.configuredKeys(remoteServer.config.headers).join(","), "Authorization");
    }

    // An auth block without a credential still withholds its client settings,
    // so it is named; an oauth block that reports nothing configured is not.
    function test_hiddenPartsMatchHasHiddenValues(): void {
        const authOnly = { config: { type: "http", url: "https://example.com/mcp",
            auth: { type: "oauth", configured: false } } };
        verify(Mcp.hasHiddenValues(authOnly));
        compare(Mcp.hiddenParts(authOnly).join(" · "), "authentication");

        const emptyOauth = { config: { type: "http", url: "https://example.com/mcp",
            oauth: { configured: false } } };
        verify(!Mcp.hasHiddenValues(emptyOauth));
        compare(Mcp.hiddenParts(emptyOauth).length, 0);

        compare(Mcp.hiddenParts(remoteServer).join(" · "),
            "headers: Authorization · OAuth client settings · URL query values");
    }

    function test_replacementTemplateContainsOnlySafeFields(): void {
        const local = JSON.parse(Mcp.template(localServer, "stdio"));
        compare(local.command, "mcp-local");
        compare(local.enabled, false);
        compare(local.timeout, 20);
        compare(local.requestIdFormat, "string");
        compare(local.cwd, "packages/local-server");
        compare(local.envPolicy, "literal");
        compare(local.auth.type, "apikey");
        compare(Object.keys(local.auth).join(","), "type");
        verify(local.auth.credentialId === undefined);
        verify(local.args === undefined);
        verify(local.env === undefined);

        const remote = JSON.parse(Mcp.template(remoteServer, "http"));
        compare(remote.url, "https://example.com/mcp");
        compare(remote.headerPolicy, "origin-locked");
        verify(remote.headers === undefined);
        verify(remote.oauth === undefined);
    }

    function test_validatesTransportAndRequiredFields(): void {
        verify(Mcp.parse('{"type":"stdio","command":"node"}', "stdio").ok);
        verify(Mcp.parse('{"type":"http","url":"https://example.com/mcp"}', "http").ok);
        verify(!Mcp.parse('{"type":"http"}', "http").ok);
        verify(!Mcp.parse('{"type":"http","url":"x"}', "sse").ok);
        verify(!Mcp.parse("[]", "stdio").ok);
    }

    function test_refusesSanitizedMarkers(): void {
        const parsed = Mcp.parse(
            '{"type":"http","url":"https://example.com/mcp?token=[configured]"}',
            "http"
        );
        verify(!parsed.ok);
        verify(parsed.error.indexOf("real value") >= 0);
    }

    function test_filtersSafeMetadata(): void {
        compare(Mcp.filtered([localServer, remoteServer], "api_token")[0].name, "local");
        compare(Mcp.filtered([localServer, remoteServer], "packages/local")[0].name, "local");
        compare(Mcp.filtered([localServer, remoteServer], "origin-locked")[0].name, "remote");
        compare(Mcp.filtered([localServer, remoteServer], "legacy")[0].name, "remote");
        compare(Mcp.filtered([localServer, remoteServer], "missing").length, 0);
    }
}
