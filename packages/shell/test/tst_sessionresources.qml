import Quickshell
import QtQuick
import QtTest
import "../qml/services"
import "FakeXhr.js" as FakeXhr

TestCase {
    id: tc
    name: "SessionResourcesLifecycle"

    property var requests: []

    function snapshot(): var {
        return {
            runtime: "pi",
            skills: [{
                name: "research",
                path: "/home/owner/.agents/skills/research/SKILL.md",
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
        Ghostd.sessionResourcesRequestFactory = function () { return FakeXhr.make(tc.requests); };
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
        compare(Ghostd.sessionResources.skills[0].name, "research");
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

    function test_reportsAMalformedSnapshotInsteadOfShowingIt(): void {
        Ghostd.fetchSessionResources(false);
        const malformed = snapshot();
        malformed.skills = "nope";
        requests[0].complete(200, malformed);
        compare(Ghostd.sessionResources, null);
        compare(Ghostd.sessionResourcesError, "ghostd sent a malformed resource snapshot");
    }
}
