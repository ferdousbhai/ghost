import Quickshell
import QtQuick
import QtTest
import qs.services

TestCase {
    id: tc
    name: "SessionResourcesLifecycle"

    property var requests: []

    function fakeRequest(): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            method: "",
            url: "",
            aborted: false,
            headers: ({}),
            onreadystatechange: null,
            open: function (method, url) {
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
            send: function () {},
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        requests.push(xhr);
        return xhr;
    }

    function snapshot(): var {
        return {
            runtime: "pi",
            obsidian: { path: "/home/owner/.agents/skills/obsidian-cli/SKILL.md", status: "admitted" },
            skills: [{
                name: "obsidian-cli",
                path: "/home/owner/.agents/skills/obsidian-cli/SKILL.md",
                source: "machine",
                precedence: 0,
                status: "admitted"
            }],
            diagnostics: [],
            mcpServers: [{
                name: "files",
                path: "/home/owner/ghosts/casper/mcp.json",
                source: "ghost",
                precedence: 1,
                enabled: false,
                status: "disabled",
                reason: "Disabled in the admitted configuration."
            }],
            mcpDiagnostics: []
        };
    }

    function init(): void {
        requests = [];
        Ghostd.clearSessionResources();
        Ghostd.listRequest = null;
        Ghostd.cancelAllTranscriptLoads();
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "pi:resource-thread";
        Ghostd.sessionIds = ({ casper: "pi:resource-thread" });
        Ghostd.apiToken = "test-token";
        Ghostd.sessionResourcesRequestFactory = function () { return tc.fakeRequest(); };
    }

    function cleanup(): void {
        Ghostd.clearSessionResources();
        Ghostd.sessionResourcesRequestFactory = null;
    }

    function test_fetchesAndValidatesTheConversationSnapshot(): void {
        Ghostd.fetchSessionResources(false);

        compare(requests.length, 1);
        compare(requests[0].method, "GET");
        verify(requests[0].url.endsWith(
            "/api/ghosts/casper/sessions/pi%3Aresource-thread/resources"));
        compare(requests[0].headers.Authorization, "Bearer test-token");
        verify(Ghostd.sessionResourcesLoading);

        requests[0].complete(200, snapshot());

        verify(!Ghostd.sessionResourcesLoading);
        compare(Ghostd.sessionResources.obsidian.status, "admitted");
        compare(Ghostd.sessionResources.skills[0].name, "obsidian-cli");
        compare(Ghostd.sessionResources.mcpServers[0].status, "disabled");
        compare(Ghostd.sessionResourcesError, "");
    }

    function test_forceRefreshRetiresTheOldOwner(): void {
        Ghostd.fetchSessionResources(false);
        const stale = requests[0];
        Ghostd.fetchSessionResources(true);

        verify(stale.aborted);
        compare(requests.length, 2);
        stale.complete(200, snapshot());
        compare(Ghostd.sessionResources, null);

        requests[1].complete(200, snapshot());
        compare(Ghostd.sessionResources.runtime, "pi");
    }

    function test_reportsMalformedAndColdClaudeResponses(): void {
        Ghostd.fetchSessionResources(false);
        const malformed = snapshot();
        malformed.obsidian.status = "unknown";
        requests[0].complete(200, malformed);
        compare(Ghostd.sessionResources, null);
        compare(Ghostd.sessionResourcesError, "ghostd sent a malformed resource snapshot");

        Ghostd.fetchSessionResources(true);
        requests[1].complete(409, {
            error: { code: "session_resources_unavailable", message: "cold" }
        });
        compare(Ghostd.sessionResources, null);
        compare(Ghostd.sessionResourcesError,
            "Send a message to start Claude Code, then refresh.");
    }
}
