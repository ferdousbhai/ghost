import QtQuick
import QtTest
import qs.services

TestCase {
    id: tc
    name: "DelegationLifecycle"

    property var requests: []

    function fakeRequest(): var {
        const xhr = {
            readyState: 0,
            status: 0,
            responseText: "",
            method: "",
            url: "",
            body: null,
            aborted: false,
            headers: ({}),
            onreadystatechange: null,
            open: function (method, url) {
                this.method = method;
                this.url = url;
                this.readyState = 1;
            },
            setRequestHeader: function (name, value) { this.headers[name] = value; },
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
        requests.push(xhr);
        return xhr;
    }

    function project(): var {
        return {
            id: "pi:thread-task",
            conversationId: "thread-task",
            runtime: "pi",
            root: "/home/owner/code/ghost",
            cwd: "/home/owner/code/ghost/packages/shell",
            relativeCwd: "packages/shell",
            name: "ghost",
            generation: 1,
            status: "ready",
            error: null,
            mcpStatus: "ready",
            resources: {
                instructions: 1, skills: 1, rules: 0, prompts: 0,
                commands: 0, agents: 0, mcpServers: 0, ignoredExecutable: 0
            },
            canRebind: true,
            lastRefreshAt: "2026-08-31T10:00:00.000Z",
            reason: "bound"
        };
    }

    function task(overrides: var, detailed: bool): var {
        const row = Object.assign({
            id: "task-11111111-1111-4111-8111-111111111111",
            harness: "codex",
            agent: null,
            cwd: "/home/owner/code/ghost/packages/shell",
            state: "running",
            createdAt: "2026-08-31T10:00:00.000Z",
            updatedAt: "2026-08-31T10:00:01.000Z",
            taskPreview: "Run focused checks.",
            taskTruncated: false,
            resultPreview: null,
            resultTruncated: false,
            error: null
        }, overrides || {});
        if (detailed) {
            row.events = [{
                sequence: 1,
                at: "2026-08-31T10:00:01.000Z",
                code: "started",
                message: "Worker started."
            }];
            row.eventsTruncated = false;
        }
        return row;
    }

    function init(): void {
        requests = [];
        Ghostd.clearDelegation(true);
        Ghostd.activeGhost = "casper";
        Ghostd.currentSessionId = "pi:thread-task";
        Ghostd.sessionIds = ({ casper: "pi:thread-task" });
        Ghostd.projectState = project();
        Ghostd.projectGhost = "casper";
        Ghostd.projectSessionId = "pi:thread-task";
        Ghostd.nativeHarnesses = [
            { id: "claude-code", availability: "available", authentication: "authenticated" },
            { id: "codex", availability: "available", authentication: "authenticated" },
            { id: "pi", availability: "available", authentication: "unknown" }
        ];
        Ghostd.nativeHarnessesLoaded = false;
        Ghostd.apiToken = "test-token";
        Ghostd.delegationRequestFactory = function () { return tc.fakeRequest(); };
    }

    function cleanup(): void {
        Ghostd.clearDelegation(true);
        Ghostd.delegationRequestFactory = null;
        Ghostd.clearProject();
    }

    function loadTasks(): void {
        Ghostd.fetchDelegatedTasks(false);
        compare(requests.length, 1);
        requests[0].complete(200, { tasks: [task()], shown: 1, total: 1 });
        compare(Ghostd.delegatedTasks.length, 1);
    }

    function test_catalogueListAndDetailUseAuthenticatedExactParentRoutes(): void {
        Ghostd.fetchNativeHarnesses(false);
        compare(requests.length, 1);
        compare(requests[0].method, "GET");
        verify(requests[0].url.endsWith("/api/harnesses"));
        compare(requests[0].headers.Authorization, "Bearer test-token");
        requests[0].complete(200, { harnesses: [
            { id: "claude-code", availability: "available", authentication: "authenticated" },
            { id: "codex", availability: "available", authentication: "authenticated" },
            { id: "pi", availability: "available", authentication: "unknown" }
        ] });
        compare(Ghostd.nativeHarnesses.length, 3);

        Ghostd.fetchDelegatedTasks(false);
        compare(requests.length, 2);
        verify(requests[1].url.indexOf(
            "/ghosts/casper/sessions/pi%3Athread-task/tasks?limit=20") >= 0);
        requests[1].complete(200, { tasks: [task()], shown: 1, total: 1 });
        Ghostd.fetchDelegatedTask(task().id, true);
        compare(requests.length, 3);
        requests[2].complete(200, task({}, true));
        compare(Ghostd.selectedDelegatedTask.events[0].message, "Worker started.");
    }

    function test_createSendCancelUseTrustedCwdAndExactStateGates(): void {
        loadTasks();
        Ghostd.createDelegatedTask("codex", "  Implement the panel.  ");
        compare(requests.length, 2);
        compare(requests[1].method, "POST");
        compare(JSON.parse(requests[1].body), {
            harness: "codex",
            assignment: "Implement the panel.",
            cwd: "/home/owner/code/ghost/packages/shell"
        });
        requests[1].complete(201, task({}, true));
        compare(Ghostd.delegatedTaskNotice, "Worker started.");

        Ghostd.sendDelegatedTask(task().id, "  Run the focused test.  ");
        compare(requests.length, 3);
        compare(JSON.parse(requests[2].body), { message: "Run the focused test." });
        requests[2].complete(200, task({}, true));

        Ghostd.cancelDelegatedTask(task().id);
        compare(requests.length, 4);
        compare(JSON.parse(requests[3].body), {});
        requests[3].complete(200, task({ state: "cancelled" }, true));
        compare(Ghostd.selectedDelegatedTask.state, "cancelled");
        Ghostd.sendDelegatedTask(task().id, "Too late");
        Ghostd.cancelDelegatedTask(task().id);
        compare(requests.length, 4);

        // Length limits are the daemon's to enforce — an oversized text goes
        // out and comes back as invalid_request; only emptiness gates here.
        Ghostd.selectedDelegatedTask = task();
        Ghostd.sendDelegatedTask(task().id, " \n\t ");
        Ghostd.createDelegatedTask("codex", " \n\t ");
        compare(requests.length, 4);
    }

    function test_mutationFencesOlderListAndDetailResponses(): void {
        loadTasks();
        Ghostd.selectedDelegatedTask = task();
        Ghostd.fetchDelegatedTask(task().id, true);
        const detail = requests[1];
        Ghostd.fetchDelegatedTasks(true);
        const listing = requests[2];

        Ghostd.cancelDelegatedTask(task().id);
        compare(requests.length, 4);
        verify(detail.aborted);
        verify(listing.aborted);
        requests[3].complete(200, task({ state: "cancelled" }, true));
        compare(Ghostd.selectedDelegatedTask.state, "cancelled");

        detail.complete(200, task({}, true));
        listing.complete(200, { tasks: [task()], shown: 1, total: 1 });
        compare(Ghostd.selectedDelegatedTask.state, "cancelled");
        compare(Ghostd.delegatedTasks[0].state, "cancelled");
    }

    function test_listAndDetailResponsesMergeTerminalStateInEitherOrder(): void {
        loadTasks();
        Ghostd.selectedDelegatedTask = task({}, true);
        Ghostd.fetchDelegatedTask(task().id, true);
        const detail = requests[1];
        Ghostd.fetchDelegatedTasks(true);
        const listing = requests[2];
        detail.complete(200, task({
            state: "completed",
            resultPreview: "Done.",
            updatedAt: "2026-08-31T10:00:03.000Z"
        }, true));
        listing.complete(200, {
            tasks: [task()], shown: 1, total: 1
        });
        compare(Ghostd.selectedDelegatedTask.state, "completed");
        compare(Ghostd.delegatedTasks[0].state, "completed");

        Ghostd.fetchDelegatedTasks(true);
        requests[3].complete(200, {
            tasks: [task({
                state: "cancelled",
                updatedAt: "2026-08-31T10:00:04.000Z"
            })], shown: 1, total: 1
        });
        Ghostd.fetchDelegatedTask(task().id, true);
        requests[4].complete(200, task({
            updatedAt: "2026-08-31T10:00:02.000Z"
        }, true));
        compare(Ghostd.selectedDelegatedTask.state, "cancelled");
        compare(Ghostd.delegatedTasks[0].state, "cancelled");
    }

    function test_equalTimestampActiveResponsesNeverMoveBackward(): void {
        loadTasks();
        Ghostd.selectedDelegatedTask = task({}, true);
        Ghostd.fetchDelegatedTask(task().id, true);
        requests[1].complete(200, task({ state: "starting" }, true));
        compare(Ghostd.selectedDelegatedTask.state, "running");
        compare(Ghostd.delegatedTasks[0].state, "running");
    }

    function test_taskMutationResponseMustMatchRequestedTask(): void {
        loadTasks();
        Ghostd.selectedDelegatedTask = task();
        Ghostd.sendDelegatedTask(task().id, "Keep reviewing.");
        compare(requests.length, 2);
        requests[1].complete(200, task({
            id: "task-22222222-2222-4222-8222-222222222222"
        }, true));
        compare(Ghostd.selectedDelegatedTask.id, task().id);
        compare(Ghostd.delegatedTasksError,
            "ghostd sent malformed delegated task state.");
    }

    function test_untrustedProjectAndStaleIdentityCannotMutateOrAdopt(): void {
        Ghostd.fetchDelegatedTasks(false);
        const stale = requests[0];
        Ghostd.currentSessionId = "pi:other";
        verify(stale.aborted);
        stale.complete(200, { tasks: [task()], shown: 1, total: 1 });
        compare(Ghostd.delegatedTasks.length, 0);

        Ghostd.currentSessionId = "pi:thread-task";
        Ghostd.prepareDelegatedTasks("casper", "pi:thread-task");
        Ghostd.projectState = Object.assign({}, project(), { root: null });
        Ghostd.createDelegatedTask("codex", "Must not start");
        compare(requests.length, 1);
    }

    function test_rawDaemonErrorsAndExpandedShapesNeverReachPresentation(): void {
        Ghostd.fetchDelegatedTasks(false);
        requests[0].complete(500, {
            error: { code: "internal", message: "stderr bearer super-secret" }
        });
        verify(Ghostd.delegatedTasksError.indexOf("super-secret") < 0);
        verify(Ghostd.delegatedTasksError.indexOf("stderr") < 0);

        Ghostd.fetchDelegatedTasks(true);
        const leaked = task();
        leaked.environment = { TOKEN: "secret" };
        requests[1].complete(200, { tasks: [leaked], shown: 1, total: 1 });
        compare(Ghostd.delegatedTasks.length, 0);
        compare(Ghostd.delegatedTasksError,
            "ghostd sent malformed delegated task state.");
    }
}
