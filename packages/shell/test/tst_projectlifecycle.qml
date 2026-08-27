import Quickshell
import QtQuick
import QtTest
import qs.services

TestCase {
    id: tc
    name: "ProjectLifecycle"

    property var gets: []
    property var previews: []
    property var mutations: []
    property var abandons: []
    property var transcripts: []
    property var renames: []

    function fakeRequest(bucket: var): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            method: "",
            url: "",
            body: null,
            aborted: false,
            onreadystatechange: null,
            open: function (method, url) {
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function () {},
            send: function (body) { this.body = body; },
            abort: function () {
                this.aborted = true;
                this.readyState = 4;
                this.status = 0;
                if (this.onreadystatechange) this.onreadystatechange();
            },
            complete: function (status, body) {
                this.status = status;
                this.responseText = typeof body === "string" ? body : JSON.stringify(body);
                this.readyState = 4;
                if (this.onreadystatechange) this.onreadystatechange();
            }
        };
        bucket.push(xhr);
        return xhr;
    }

    function resources(overrides: var): var {
        return Object.assign({
            instructions: 0, skills: 0, rules: 0, prompts: 0,
            commands: 0, agents: 0, mcpServers: 0, ignoredExecutable: 0
        }, overrides || {});
    }

    function project(id: string, overrides: var): var {
        const at = id.indexOf(":");
        const runtime = id.slice(0, at);
        const conversationId = id.slice(at + 1);
        return Object.assign({
            id, conversationId, runtime,
            root: null,
            cwd: "/home/owner",
            relativeCwd: null,
            name: null,
            generation: 0,
            status: "unbound",
            error: null,
            mcpStatus: "off",
            resources: resources(),
            canRebind: true,
            lastRefreshAt: null,
            reason: "default"
        }, overrides || {});
    }

    function bound(id: string, generation: int): var {
        return project(id, {
            root: "/home/owner/code/ghost",
            cwd: "/home/owner/code/ghost/packages/shell",
            relativeCwd: "packages/shell",
            name: "ghost",
            generation,
            status: "ready",
            mcpStatus: "ready",
            resources: resources({ instructions: 1, skills: 3, mcpServers: 2 }),
            lastRefreshAt: "2026-08-26T10:00:00.000Z",
            reason: generation === 1 ? "bound" : "reloaded"
        });
    }

    function init(): void {
        Ghostd.clearProject();
        Ghostd.activeGhost = "casper";
        Ghostd.ghosts = [{
            name: "casper", dir: "/tmp/ghosts/casper",
            createdAt: "2026-08-26T10:00:00.000Z"
        }];
        Ghostd.sessions = [];
        Ghostd.turnStates = ({});
        Ghostd.liveConversationKeys = [];
        Ghostd.sessionIds = ({ casper: "pi:thread-project" });
        Ghostd.currentSessionId = "pi:thread-project";
        Ghostd.ensureTurnState("casper", "pi:thread-project", "thread-project", "pi");
        Ghostd.showTurnState("casper", "pi:thread-project");
        Ghostd.currentModel = null;
        Ghostd.apiToken = "test-token";
        gets = [];
        previews = [];
        mutations = [];
        abandons = [];
        transcripts = [];
        renames = [];
        Ghostd.projectRequestFactory = function () { return tc.fakeRequest(gets); };
        Ghostd.projectPreviewRequestFactory = function () { return tc.fakeRequest(previews); };
        Ghostd.projectMutationRequestFactory = function () { return tc.fakeRequest(mutations); };
        Ghostd.projectAbandonRequestFactory = function () { return tc.fakeRequest(abandons); };
        Ghostd.transcriptRequestFactory = function () { return tc.fakeRequest(transcripts); };
        Ghostd.renameGhostRequestFactory = function () { return tc.fakeRequest(renames); };
        Ghostd.renamingGhost = "";
        Ghostd.renameGhostSnapshot = null;
        Ghostd.renameGhostProjectSnapshot = null;
    }

    function cleanup(): void {
        Ghostd.cancelAllTranscriptLoads();
        Ghostd.projectRequestFactory = null;
        Ghostd.projectPreviewRequestFactory = null;
        Ghostd.projectMutationRequestFactory = null;
        Ghostd.projectAbandonRequestFactory = null;
        Ghostd.transcriptRequestFactory = null;
        Ghostd.renameGhostRequestFactory = null;
        Ghostd.renameGhostRequest = null;
        Ghostd.renamingGhost = "";
        Ghostd.renameGhostSnapshot = null;
        Ghostd.renameGhostProjectSnapshot = null;
        Ghostd.clearProject();
        Ghostd.sessions = [];
        Ghostd.currentModel = null;
    }

    function loadHome(): void {
        Ghostd.fetchProject(false, false);
        compare(gets.length, 1);
        gets[0].complete(200, project("pi:thread-project"));
        compare(Ghostd.projectState.status, "unbound");
    }

    function test_forcedGetRetiresOutOfOrderState(): void {
        Ghostd.fetchProject(false, false);
        compare(gets.length, 1);
        const stale = gets[0];
        Ghostd.fetchProject(true, false);
        compare(gets.length, 2);
        verify(stale.aborted);
        stale.complete(200, bound("pi:thread-project", 8));
        compare(Ghostd.projectState.id, "");
        gets[1].complete(200, project("pi:thread-project"));
        compare(Ghostd.projectState.id, "pi:thread-project");
        compare(Ghostd.projectState.root, null);
    }

    function test_previewThenTrustUsesGenerationAndCanonicalRoot(): void {
        loadHome();
        Ghostd.previewProject("/typed/path");
        compare(previews.length, 1);
        compare(JSON.parse(previews[0].body).path, "/typed/path");
        previews[0].complete(200, {
            root: "/home/owner/code/ghost",
            name: "ghost",
            trustToken: "opaque",
            expiresAt: "2099-01-01T00:00:00.000Z",
            resources: resources({ skills: 3, mcpServers: 2 }),
            warnings: []
        });
        compare(Ghostd.projectPreview.root, "/home/owner/code/ghost");

        Ghostd.bindProject();
        compare(mutations.length, 1);
        compare(mutations[0].method, "PUT");
        const sent = JSON.parse(mutations[0].body);
        compare(sent.root, "/home/owner/code/ghost");
        compare(sent.cwd, "/home/owner/code/ghost");
        compare(sent.trustToken, "opaque");
        compare(sent.expectedGeneration, 0);
        mutations[0].complete(200, bound("pi:thread-project", 1));
        compare(Ghostd.projectState.generation, 1);
        compare(Ghostd.projectPreview, null);
    }

    function test_unbindReturnsCwdToOwnerHome(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 3));
        Ghostd.unbindProject();
        compare(mutations.length, 1);
        const sent = JSON.parse(mutations[0].body);
        compare(sent.root, null);
        compare(sent.expectedGeneration, 3);
        compare(sent.cwd, Quickshell.env("HOME"));
        mutations[0].complete(200, project("pi:thread-project", {
            generation: 4,
            cwd: Quickshell.env("HOME"),
            lastRefreshAt: "2026-08-26T10:01:00.000Z",
            reason: "unbound"
        }));
        compare(Ghostd.projectState.root, null);
        compare(Ghostd.projectState.generation, 4);
    }

    function test_newConversationAbandonsBoundPreTurnDraftBeforeReplacingIt(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 1));
        const oldKey = Ghostd.conversationKey("casper", "pi:thread-project");

        Ghostd.newConversation();
        compare(abandons.length, 1);
        compare(abandons[0].method, "DELETE");
        verify(abandons[0].url.indexOf(
            "/ghosts/casper/sessions/pi%3Athread-project/project/draft") >= 0);
        compare(Ghostd.currentSessionId, "pi:thread-project");
        compare(Ghostd.projectState.root, "/home/owner/code/ghost");
        verify(Ghostd.projectMutating);

        abandons[0].complete(200, {
            ok: true,
            id: "pi:thread-project",
            conversationId: "thread-project",
            runtime: "pi",
            abandoned: true
        });
        verify(!Ghostd.projectMutating);
        verify(Ghostd.currentSessionId !== "pi:thread-project");
        verify(Ghostd.currentSessionId.indexOf("pi:hud-") === 0);
        verify(Ghostd.turnStates[oldKey] === undefined);
        compare(Ghostd.projectState.id, "");
    }

    function test_commandOnlyBoundDraftStillUsesAbandonBeforeReplacement(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 2));
        const state = Ghostd.activeTurnState(false);
        state.rows = [{
            role: "command", text: "cwd: /home/owner/code/ghost", tools: "",
            toolActivity: [], error: "", pending: false, entryId: ""
        }];

        Ghostd.newConversation();
        compare(abandons.length, 1);
        compare(Ghostd.currentSessionId, "pi:thread-project");
        abandons[0].complete(200, {
            ok: true,
            id: "pi:thread-project",
            conversationId: "thread-project",
            runtime: "pi",
            abandoned: true
        });
        verify(Ghostd.currentSessionId !== "pi:thread-project");
    }

    function test_failedDraftAbandonKeepsGhostAndRetriesSameIdentity(): void {
        Ghostd.ghosts = Ghostd.ghosts.concat([{
            name: "spooky", dir: "/tmp/ghosts/spooky",
            createdAt: "2026-08-26T10:00:00.000Z"
        }]);
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 1));

        Ghostd.selectGhost("spooky");
        compare(abandons.length, 1);
        compare(Ghostd.activeGhost, "casper");
        abandons[0].complete(409, {
            error: { code: "session_busy", message: "Project cleanup is busy." }
        });
        compare(Ghostd.activeGhost, "casper");
        compare(Ghostd.currentSessionId, "pi:thread-project");
        compare(Ghostd.projectState.root, "/home/owner/code/ghost");
        verify(Ghostd.projectError.indexOf("busy") >= 0);

        Ghostd.selectGhost("spooky");
        compare(abandons.length, 2);
        verify(abandons[1].url.indexOf("pi%3Athread-project/project/draft") >= 0);
        abandons[1].complete(200, {
            ok: true,
            id: "pi:thread-project",
            conversationId: "thread-project",
            runtime: "pi",
            abandoned: true
        });
        compare(Ghostd.activeGhost, "spooky");
        compare(Ghostd.currentSessionId, "");
    }

    function test_openStoredConversationWaitsForBoundDraftAbandon(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 1));
        Ghostd.sessions = [{
            id: "pi:stored",
            conversationId: "stored",
            runtime: "pi",
            title: "Stored",
            createdAt: "2026-08-26T10:00:00.000Z",
            updatedAt: "2026-08-26T10:00:00.000Z",
            messageCount: 2,
            pinned: false,
            unread: false,
            localOnly: true
        }];

        Ghostd.openConversation("pi:stored");
        compare(abandons.length, 1);
        compare(Ghostd.currentSessionId, "pi:thread-project");
        abandons[0].complete(200, {
            ok: true,
            id: "pi:thread-project",
            conversationId: "thread-project",
            runtime: "pi",
            abandoned: true
        });
        compare(Ghostd.currentSessionId, "pi:stored");
        compare(transcripts.length, 1);
        verify(transcripts[0].url.indexOf("/sessions/pi%3Astored/transcript") >= 0);
    }

    function test_publishedBoundConversationIsNeverSentToDraftAbandon(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 4));
        Ghostd.sessions = [{
            id: "pi:thread-project",
            conversationId: "thread-project",
            runtime: "pi",
            title: "Published",
            createdAt: "2026-08-26T10:00:00.000Z",
            updatedAt: "2026-08-26T10:00:00.000Z",
            messageCount: 2,
            pinned: false,
            unread: false
        }];

        Ghostd.newConversation();
        compare(abandons.length, 0);
        verify(Ghostd.currentSessionId !== "pi:thread-project");
    }

    function test_retiredDraftAbandonCallbackCannotReplaceNewerUiState(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 1));
        Ghostd.newConversation();
        const stale = abandons[0];
        Ghostd.clearProject();
        verify(stale.aborted);

        stale.complete(200, {
            ok: true,
            id: "pi:thread-project",
            conversationId: "thread-project",
            runtime: "pi",
            abandoned: true
        });
        compare(Ghostd.currentSessionId, "pi:thread-project");
        compare(Ghostd.projectState.id, "");
    }

    function test_projectEventRefreshesOnlyActiveConversation(): void {
        loadHome();
        Ghostd.ingestConversationEvents("data: " + JSON.stringify({
            type: "conversation-updated",
            id: "pi:another",
            conversationId: "another",
            runtime: "pi",
            reason: "project",
            updatedAt: "2026-08-26T10:00:00.000Z"
        }) + "\n\n", "casper");
        compare(gets.length, 1);
        Ghostd.ingestConversationEvents("data: " + JSON.stringify({
            type: "conversation-updated",
            id: "pi:thread-project",
            conversationId: "thread-project",
            runtime: "pi",
            reason: "project",
            updatedAt: "2026-08-26T10:00:01.000Z"
        }) + "\n\n", "casper");
        compare(gets.length, 2);
    }

    function test_trustedDraftCannotSilentlyChangeRuntime(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 1));
        Ghostd.currentModel = { provider: "claude-code", id: "claude" };
        Ghostd.send("do not send this");
        verify(!Ghostd.streaming);
        verify(Ghostd.projectError.indexOf("trusted project is bound to Pi") >= 0);
        compare(Ghostd.currentSessionId, "pi:thread-project");
    }

    function test_renameRetiresEveryProjectOwnerAndUsesSettledDaemonName(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 3));
        Ghostd.previewProject("/home/owner/code/another");
        const stalePreview = previews[0];
        Ghostd.fetchProject(true, false);
        const staleGet = gets[1];
        const staleMutation = tc.fakeRequest(mutations);
        staleMutation.readyState = 1;
        Ghostd.projectMutationRequest = staleMutation;

        verify(Ghostd.renameGhost("casper", "spooky"));
        compare(renames.length, 1);
        verify(staleGet.aborted);
        verify(stalePreview.aborted);
        verify(staleMutation.aborted);
        compare(Ghostd.projectGhost, "spooky");

        staleGet.complete(200, bound("pi:thread-project", 99));
        stalePreview.complete(200, {
            root: "/stale", name: "stale", trustToken: "stale",
            expiresAt: "2099-01-01T00:00:00.000Z",
            resources: resources(), warnings: []
        });
        compare(Ghostd.projectState.generation, 3);
        compare(Ghostd.projectPreview, null);

        renames[0].complete(200, { ok: true, name: "spirit" });
        compare(Ghostd.activeGhost, "spirit");
        compare(Ghostd.projectGhost, "spirit");
        compare(gets.length, 3);
        verify(gets[2].url.indexOf("/ghosts/spirit/sessions/pi%3Athread-project/project") >= 0);
        gets[2].complete(200, bound("pi:thread-project", 4));
        compare(Ghostd.projectState.generation, 4);
    }

    function test_renameRollbackRestoresThenRefetchesOldProject(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 6));
        Ghostd.projectNotice = "Keep this notice.";
        Ghostd.fetchProject(true, false);
        const staleGet = gets[1];

        verify(Ghostd.renameGhost("casper", "spooky"));
        verify(staleGet.aborted);
        renames[0].complete(409, {
            error: { code: "ghost_busy", message: "A project transition still owns this ghost." }
        });
        compare(Ghostd.activeGhost, "casper");
        compare(Ghostd.projectGhost, "casper");
        compare(Ghostd.projectState.generation, 6);
        compare(Ghostd.projectNotice, "Keep this notice.");
        verify(Ghostd.ghostRenameError.indexOf("project transition") >= 0);

        staleGet.complete(200, bound("pi:thread-project", 99));
        compare(Ghostd.projectState.generation, 6);
        wait(0);
        compare(gets.length, 3);
        verify(gets[2].url.indexOf("/ghosts/casper/sessions/pi%3Athread-project/project") >= 0);
        gets[2].complete(200, bound("pi:thread-project", 7));
        compare(Ghostd.projectState.generation, 7);
    }

    function test_renameWaitsForProjectMutationLikeDaemonGhostBusyGate(): void {
        Ghostd.fetchProject(false, false);
        gets[0].complete(200, bound("pi:thread-project", 2));
        Ghostd.reloadProject();
        compare(mutations.length, 1);
        verify(Ghostd.projectMutating);
        verify(!Ghostd.renameGhost("casper", "spooky"));
        compare(renames.length, 0);
        verify(Ghostd.ghostRenameError.indexOf("project change") >= 0);
        verify(!mutations[0].aborted);
        mutations[0].complete(409, {
            error: { code: "session_busy", message: "Still changing." }
        });
        verify(!Ghostd.projectMutating);
    }
}
