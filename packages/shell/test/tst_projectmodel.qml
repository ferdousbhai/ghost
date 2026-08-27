import QtQuick
import QtTest
import "../qml/components/ProjectModel.js" as ProjectModel

TestCase {
    name: "ProjectModel"

    function counts(overrides: var): var {
        return Object.assign({
            instructions: 1,
            skills: 2,
            rules: 0,
            prompts: 0,
            commands: 3,
            agents: 1,
            mcpServers: 2,
            ignoredExecutable: 0
        }, overrides || {});
    }

    function state(overrides: var): var {
        return Object.assign({
            id: "pi:thread-1",
            conversationId: "thread-1",
            runtime: "pi",
            root: "/home/owner/code/ghost",
            cwd: "/home/owner/code/ghost/packages/shell",
            relativeCwd: "packages/shell",
            name: "ghost",
            generation: 4,
            status: "ready",
            error: null,
            mcpStatus: "ready",
            resources: counts(),
            canRebind: true,
            lastRefreshAt: "2026-08-26T10:00:00.000Z",
            reason: "resumed"
        }, overrides || {});
    }

    function test_acceptsCompleteBoundAndUnboundStates(): void {
        const bound = ProjectModel.state(state(), "pi:thread-1");
        verify(bound.ok);
        compare(bound.state.relativeCwd, "packages/shell");
        compare(ProjectModel.title(bound.state), "ghost");
        compare(ProjectModel.pathLabel(bound.state), "packages/shell");
        compare(ProjectModel.mcpLabel(bound.state), "MCP ready");

        const atRoot = ProjectModel.state(state({
            cwd: "/home/owner/code/ghost",
            relativeCwd: "."
        }), "pi:thread-1");
        verify(atRoot.ok);
        compare(ProjectModel.pathLabel(atRoot.state), "Project root");

        const filesystemRoot = ProjectModel.state(state({
            root: "/",
            cwd: "/",
            relativeCwd: ".",
            name: "/"
        }), "pi:thread-1");
        verify(filesystemRoot.ok);
        compare(ProjectModel.title(filesystemRoot.state), "/");

        const home = ProjectModel.state(state({
            root: null,
            cwd: "/home/owner",
            relativeCwd: null,
            name: null,
            generation: 0,
            status: "unbound",
            mcpStatus: "off",
            resources: counts({
                instructions: 0, skills: 0, commands: 0, agents: 0, mcpServers: 0
            }),
            lastRefreshAt: null,
            reason: "default"
        }), "pi:thread-1");
        verify(home.ok);
        compare(ProjectModel.title(home.state), "Home");
        compare(ProjectModel.pathLabel(home.state), "Owner home");
    }

    function test_rejectsIdentityDepthAndResourceLies(): void {
        verify(!ProjectModel.state(state({ id: "pi:other" }), "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ runtime: "claude-code" }), "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ cwd: "relative/path" }), "pi:thread-1").ok);
        verify(!ProjectModel.state(state({
            cwd: "/home/owner/elsewhere", relativeCwd: "elsewhere"
        }), "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ resources: counts({ skills: -1 }) }),
            "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ root: null }), "pi:thread-1").ok);
    }

    function test_rejectsNoncanonicalAndInconsistentStrictState(): void {
        verify(!ProjectModel.state(state({ generation: 9007199254740992 }),
            "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ cwd: "/home/owner//code/ghost" }),
            "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ cwd: "/home/owner/code/ghost/../elsewhere" }),
            "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ name: "spoofed" }), "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ lastRefreshAt: "2026-02-30T10:00:00.000Z" }),
            "pi:thread-1").ok);

        const extraState = state();
        extraState.warnings = [];
        verify(!ProjectModel.state(extraState, "pi:thread-1").ok);
        verify(!ProjectModel.state(state({ resources: Object.assign(counts(), { extra: 1 }) }),
            "pi:thread-1").ok);
        verify(!ProjectModel.state(state({
            error: { code: "failed", message: "Nope", path: "/private" }
        }), "pi:thread-1").ok);

        const unbound = {
            root: null,
            cwd: "/home/owner",
            relativeCwd: null,
            name: null,
            status: "unbound",
            lastRefreshAt: null,
            reason: "default"
        };
        verify(!ProjectModel.state(state(Object.assign({}, unbound, {
            mcpStatus: "ready"
        })), "pi:thread-1").ok);
        verify(!ProjectModel.state(state(Object.assign({}, unbound, {
            resources: counts({ skills: 1 })
        })), "pi:thread-1").ok);
        verify(!ProjectModel.state(state(Object.assign({}, unbound, {
            error: { code: "failed", message: "Nope" }
        })), "pi:thread-1").ok);
    }

    function test_previewIsCountOnlyAndWarningsAreStrings(): void {
        const parsed = ProjectModel.preview({
            root: "/home/owner/code/ghost",
            name: "ghost",
            trustToken: "opaque-token",
            expiresAt: "2026-08-26T11:00:00.000Z",
            resources: counts(),
            warnings: ["One executable artifact is ignored."]
        });
        verify(parsed.ok);
        compare(parsed.preview.warnings.length, 1);
        verify(!ProjectModel.preview({
            root: "/home/owner/code/ghost",
            name: "ghost",
            trustToken: "token",
            expiresAt: "later",
            resources: counts(),
            warnings: [{ message: "leaky shape" }]
        }).ok);

        const extra = {
            root: "/home/owner/code/ghost",
            name: "ghost",
            trustToken: "token",
            expiresAt: "2026-08-26T11:00:00.000Z",
            resources: counts(),
            warnings: [],
            cwd: "/private"
        };
        verify(!ProjectModel.preview(extra).ok);
        extra.expiresAt = "2026-02-30T11:00:00.000Z";
        delete extra.cwd;
        verify(!ProjectModel.preview(extra).ok);
        extra.expiresAt = "2026-08-26T11:00:00.000Z";
        extra.root = "/home/owner/code/ghost/";
        verify(!ProjectModel.preview(extra).ok);
    }

    function test_resourceSummaryAndRecentPathsStayBounded(): void {
        const summary = ProjectModel.resourceSummary(state());
        verify(summary.indexOf("2 skills") >= 0);
        verify(summary.indexOf("2 MCP servers") >= 0);
        verify(summary.indexOf("1 agent definition (inactive)") >= 0);
        verify(summary.toLowerCase().indexOf("helper") < 0);
        let recent = [];
        for (const path of ["/a", "/b", "/c", "/d"]) {
            recent = ProjectModel.remember(recent, path, 3);
        }
        compare(recent.join(","), "/d,/c,/b");
        compare(ProjectModel.remember(recent, "/c", 3).join(","), "/c,/d,/b");
    }
}
