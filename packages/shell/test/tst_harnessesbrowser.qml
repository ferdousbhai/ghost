import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    id: tc
    name: "HarnessesBrowser"
    when: windowShown
    width: 940
    height: 720
    visible: true

    property var requests: []

    Component {
        id: browserComponent
        HarnessesBrowser {
            width: 900
            height: 680
        }
    }

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
            send: function (body) { this.body = body === undefined ? null : body; },
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
        tc.requests.push(xhr);
        return xhr;
    }

    function workspace(overrides: var): var {
        return Object.assign({
            strategy: "git-worktree",
            state: "active",
            root: "/state/ghost/task-worktrees/repo/task-11111111-1111-4111-8111-111111111111",
            cwd: "/state/ghost/task-worktrees/repo/task-11111111-1111-4111-8111-111111111111/packages/app",
            branch: "ghost/task-11111111-1111-4111-8111-111111111111",
            baseCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            headCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            review: "pending",
            notice: "Running in an isolated worktree."
        }, overrides || {});
    }

    function detail(overrides: var): var {
        return Object.assign({
            version: 3,
            id: "task-11111111-1111-4111-8111-111111111111",
            parent: { id: "pi:conversation-1", runtime: "pi", conversationId: "conversation-1" },
            harness: "claude-code",
            agent: "reviewer",
            task: "Implement the parser and verify the boundary tests.",
            root: "/project",
            cwd: "/project/packages/app",
            workspace: workspace(),
            state: "running",
            createdAt: "2026-08-30T09:00:00.000Z",
            updatedAt: "2026-08-30T09:01:00.000Z",
            nativeSessionId: "native-1",
            result: null,
            resultTruncated: false,
            error: null,
            events: [
                { sequence: 1, at: "2026-08-30T09:00:00.000Z", type: "state", state: "queued" },
                { sequence: 2, at: "2026-08-30T09:01:00.000Z", type: "notice", text: "Claude Code started.", textTruncated: false }
            ],
            eventsTruncated: false
        }, overrides || {});
    }

    function summary(overrides: var): var {
        const task = detail(overrides);
        return {
            id: task.id,
            parent: task.parent,
            harness: task.harness,
            agent: task.agent,
            taskPreview: task.task,
            root: task.root,
            cwd: task.cwd,
            workspace: task.workspace,
            state: task.state,
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
            nativeSessionId: task.nativeSessionId,
            resultPreview: task.result,
            resultTruncated: task.resultTruncated,
            error: task.error
        };
    }

    function harnesses(): var {
        return {
            harnesses: [
                {
                    id: "claude-code", name: "Claude Code", kind: "native",
                    nativeConfiguration: true, installation: "installed",
                    authentication: "authenticated", reason: null,
                    usage: {
                        state: "ready", stale: false,
                        limits: [{ label: "Session", usedFraction: 0.25, resetsAt: null }]
                    }
                },
                {
                    id: "codex", name: "Codex", kind: "native",
                    nativeConfiguration: true, installation: "installed",
                    authentication: "authenticated", reason: null,
                    usage: {
                        state: "ready", stale: false,
                        limits: [{ label: "Week", usedFraction: 0.6, resetsAt: null }]
                    }
                },
                {
                    id: "pi", name: "Pi", kind: "native",
                    nativeConfiguration: true, installation: "installed",
                    authentication: "unknown", reason: null, usage: null
                }
            ]
        };
    }

    function requestEnding(suffix: string, from: int): var {
        for (let index = from || 0; index < requests.length; index += 1) {
            if (requests[index].url.endsWith(suffix)) return requests[index];
        }
        return null;
    }

    function createLoadedBrowser(): var {
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        tryCompare(requests, "length", 2);
        requestEnding("/harnesses", 0).complete(200, harnesses());
        requestEnding("/tasks", 0).complete(200, { tasks: [summary()], skipped: [] });
        wait(0);
        waitForRendering(browser);
        return browser;
    }

    function init(): void {
        Ghostd.clearCoding();
        Ghostd.activeGhost = "casper";
        Ghostd.apiToken = "test-token";
        requests = [];
        Ghostd.codingRequestFactory = function () { return tc.fakeRequest(); };
    }

    function cleanup(): void {
        Ghostd.clearCoding();
        Ghostd.codingRequestFactory = null;
    }

    function test_statusTasksAndDetailAreLiteralAndReviewable(): void {
        const browser = createLoadedBrowser();
        compare(Ghostd.codingHarnesses.length, 3);
        compare(findChild(browser, "codingHarnessUsage-claude-code").text, "Session 75% left");
        compare(findChild(browser, "codingHarnessUsage-codex").text, "Week 40% left");
        compare(findChild(browser, "codingHarnessState-pi").text, "Ready");
        verify(findChild(browser, "codingTaskList") !== null);

        const row = findChild(browser, "codingTask-task-11111111-1111-4111-8111-111111111111");
        verify(row !== null);
        row.forceActiveFocus();
        keyClick(Qt.Key_Return);
        tryCompare(requests, "length", 3);
        verify(requests[2].url.endsWith("/tasks/task-11111111-1111-4111-8111-111111111111"));
        requests[2].complete(200, detail());
        wait(0);

        compare(findChild(browser, "codingTaskState").text,
            "claude-code · reviewer · Running");
        compare(findChild(browser, "codingTaskAssignment").text,
            "Implement the parser and verify the boundary tests.");
        compare(findChild(browser, "codingTaskWorkspaceSummary").text, "Isolated worktree");
        compare(findChild(browser, "codingTaskBranch").text,
            "ghost/task-11111111-1111-4111-8111-111111111111");
        compare(findChild(browser, "codingTaskWorkspacePath").text, workspace().root);
    }

    function test_sendAndCancelUseExactReverseRoutes(): void {
        const browser = createLoadedBrowser();
        Ghostd.selectCodingTask(summary().id);
        requests[2].complete(200, detail());
        wait(0);

        browser.messageDraft = " Check the edge case. ";
        const send = findChild(browser, "codingTaskSend");
        verify(send.enabled);
        send.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(requests[3].method, "POST");
        verify(requests[3].url.endsWith("/messages"));
        compare(requests[3].body, '{"text":"Check the edge case."}');
        requests[3].complete(200, detail({
            events: detail().events.concat([{
                sequence: 3, at: "2026-08-30T09:02:00.000Z",
                type: "owner_message", text: "Check the edge case.", textTruncated: false
            }])
        }));
        compare(browser.messageDraft, "");
        // A successful mutation refreshes the summary list.
        compare(requests[4].method, "GET");
        requests[4].complete(200, { tasks: [summary()], skipped: [] });
        // List refresh also refreshes the selected detail.
        requests[5].complete(200, detail());

        const cancel = findChild(browser, "codingTaskCancel");
        cancel.forceActiveFocus();
        keyClick(Qt.Key_Return);
        compare(requests[6].method, "POST");
        verify(requests[6].url.endsWith("/cancel"));
        compare(requests[6].body, "{}");
        const cancelled = detail({
            state: "cancelled",
            workspace: workspace({ state: "removed", review: "no_changes" })
        });
        requests[6].complete(200, { outcome: "cancelled", task: cancelled });
        compare(Ghostd.selectedCodingTask.state, "cancelled");
    }

    function test_taskRefreshPreservesDraftForSameTask(): void {
        const browser = createLoadedBrowser();
        Ghostd.selectCodingTask(summary().id);
        requests[2].complete(200, detail());
        browser.messageDraft = "Keep this draft";

        Ghostd.fetchCodingTasks(true);
        requests[3].complete(200, { tasks: [summary()], skipped: [] });
        requests[4].complete(200, detail({ updatedAt: "2026-08-30T09:02:00.000Z" }));

        compare(browser.messageDraft, "Keep this draft");
    }

    function test_pollingAndGhostChangeRetireOwnedRequests(): void {
        const browser = createLoadedBrowser();
        const taskTimer = findChild(browser, "codingTaskPoll");
        const harnessTimer = findChild(browser, "codingHarnessPoll");
        verify(taskTimer.running);
        verify(harnessTimer.running);
        compare(taskTimer.interval, 3000);
        compare(harnessTimer.interval, 30000);

        taskTimer.triggered();
        harnessTimer.triggered();
        compare(requests.length, 4);
        const pendingTasks = requestEnding("/tasks", 2);
        const pendingHarnesses = requestEnding("/harnesses", 2);
        Ghostd.activeGhost = "moaning-myrtle";
        verify(pendingTasks.aborted);
        verify(pendingHarnesses.aborted);
        compare(Ghostd.codingTasks.length, 0);
        compare(Ghostd.codingHarnesses.length, 0);
    }

    function test_malformedPayloadFailsClosed(): void {
        const browser = createTemporaryObject(browserComponent, tc);
        verify(browser !== null);
        tryCompare(requests, "length", 2);
        requestEnding("/harnesses", 0).complete(200, { harnesses: [{ id: "unknown" }] });
        requestEnding("/tasks", 0).complete(200, { tasks: [{ id: "task-bad" }], skipped: [] });
        compare(Ghostd.codingHarnesses.length, 0);
        compare(Ghostd.codingTasks.length, 0);
        compare(Ghostd.codingHarnessesError, "ghostd sent malformed harness status");
        compare(Ghostd.codingTasksError, "ghostd sent malformed coding task state");
    }
}
