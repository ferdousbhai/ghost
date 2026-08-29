import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    id: tc
    name: "WorkStrip"
    when: windowShown
    width: 760
    height: 720
    visible: true

    property var requests: []

    Component {
        id: stripComponent
        WorkStrip {
            width: 700
            height: implicitHeight
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

    function todo(): var {
        return [
            {
                name: "Build",
                tasks: [
                    { content: "Read contract", status: "completed" },
                    { content: "Wire state", status: "completed" },
                    { content: "Build strip", status: "in_progress" }
                ]
            },
            {
                name: "Verify",
                tasks: [
                    { content: "Write tests", status: "completed" },
                    { content: "Run preview", status: "blocked", blocker: "Nested compositor busy" },
                    { content: "Run lint", status: "pending" },
                    { content: "Drop old draft", status: "abandoned" }
                ]
            }
        ];
    }

    function planState(overrides: var): var {
        return Object.assign({ planning: false, plan: null, todo: [] }, overrides || {});
    }

    function approvedPlan(): var {
        return {
            path: "/tmp/ghost-approved-plan.md",
            title: "Approved HUD plan",
            approvedAt: "2026-08-28T10:00:00.000Z",
            content: "# Approved HUD plan"
        };
    }

    function job(id: string, status: string, overrides: var): var {
        return Object.assign({
            id: id,
            label: "Job " + id,
            command: "run " + id,
            status: status,
            startedAt: "2026-08-28T10:00:00.000Z",
            durationMs: 1200,
            output: "output for " + id,
            outputTruncated: false
        }, overrides || {});
    }

    function requestEnding(suffix: string, from: int): var {
        for (let index = from || 0; index < requests.length; index += 1) {
            if (requests[index].url.endsWith(suffix)) return requests[index];
        }
        return null;
    }

    function createLoadedStrip(planBody: var, jobs: var): var {
        const strip = createTemporaryObject(stripComponent, tc);
        verify(strip !== null);
        tryCompare(requests, "length", 2);
        const planRequest = requestEnding("/plan", 0);
        const jobsRequest = requestEnding("/jobs", 0);
        verify(planRequest !== null);
        verify(jobsRequest !== null);
        planRequest.complete(200, planBody);
        jobsRequest.complete(200, { jobs: jobs || [] });
        wait(0);
        if (strip.visible) waitForRendering(strip);
        return strip;
    }

    function init(): void {
        Ghostd.hudVisible = false;
        Ghostd.clearWork();
        Workbench.close();
        Ghostd.activeGhost = "casper";
        Ghostd.sessionIds = ({ casper: "pi:work-strip" });
        Ghostd.currentSessionId = "pi:work-strip";
        Ghostd.streaming = false;
        requests = [];
        Ghostd.workRequestFactory = function () { return tc.fakeRequest(); };
        Ghostd.apiToken = "test-token";
        Ghostd.hudVisible = true;
    }

    function cleanup(): void {
        Ghostd.hudVisible = false;
        Ghostd.clearWork();
        Ghostd.workRequestFactory = null;
        Ghostd.streaming = false;
        Workbench.close();
    }

    function test_hiddenWhenAllWorkIsEmpty(): void {
        const strip = createLoadedStrip(planState(), []);
        verify(!strip.visible);
        compare(strip.implicitHeight, 0);
    }

    function test_planningStopUsesExactPostAndKeyboard(): void {
        const strip = createLoadedStrip(planState({ planning: true, todo: todo() }), []);
        verify(strip.visible);
        const chip = findChild(strip, "workPlanChipText");
        const stop = findChild(strip, "workPlanStopButton");
        compare(chip.text, "Planning");
        verify(stop.visible);
        compare(stop.Accessible.description, "Leave plan mode and keep any approved plan.");

        stop.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(requests.length, 3);
        compare(requests[2].method, "POST");
        verify(requests[2].url.endsWith("/sessions/pi%3Awork-strip/plan"));
        compare(requests[2].body, '{"action":"stop"}');
        requests[2].complete(200, planState({ todo: todo() }));
        verify(!Ghostd.workPlanning);
    }

    function test_approvedPlanOpensAndClearsFromKeyboard(): void {
        const strip = createLoadedStrip(planState({ plan: approvedPlan() }), []);
        const open = findChild(strip, "workPlanOpenButton");
        const clear = findChild(strip, "workPlanClearButton");
        verify(open.visible);
        verify(clear.visible);

        open.forceActiveFocus();
        keyClick(Qt.Key_Return);
        compare(Workbench.filePath, "/tmp/ghost-approved-plan.md");

        clear.forceActiveFocus();
        keyClick(Qt.Key_Space);
        compare(requests.length, 3);
        compare(requests[2].body, '{"action":"clear"}');
    }

    function test_todoSummaryAndEveryRealStatus(): void {
        const strip = createLoadedStrip(planState({ todo: todo() }), []);
        const summary = findChild(strip, "workTodoSummary");
        const toggle = findChild(strip, "workTodoToggle");
        compare(summary.text, "Todo · 3/7 done · Now: Build strip");
        mouseClick(toggle, toggle.width / 2, toggle.height / 2);
        verify(strip.todoExpanded);
        toggle.forceActiveFocus();
        keyClick(Qt.Key_Space);
        verify(!strip.todoExpanded);
        keyClick(Qt.Key_Enter);
        verify(strip.todoExpanded);
        verify(findChild(strip, "workTodoList").visible);

        const done = findChild(strip, "workTodoTask-0-0");
        const active = findChild(strip, "workTodoTask-0-2");
        const blocked = findChild(strip, "workTodoTask-1-1");
        const pending = findChild(strip, "workTodoTask-1-2");
        const abandoned = findChild(strip, "workTodoTask-1-3");
        compare(done.status, "completed");
        compare(done.glyph, "✓");
        compare(active.status, "in_progress");
        compare(active.glyph, "▸");
        compare(blocked.status, "blocked");
        compare(blocked.glyph, "⊘");
        compare(pending.status, "pending");
        compare(pending.glyph, "·");
        compare(abandoned.status, "abandoned");
        compare(abandoned.glyph, "−");
    }

    function test_jobsExpandOutputAndCancelReplacesTheRightRow(): void {
        const jobs = [
            job("running-a", "running", {}),
            job("running-b", "running", { durationMs: 45000 }),
            job("done", "completed", {
                durationMs: 190000,
                endedAt: "2026-08-28T10:03:10.000Z",
                exitCode: 0,
                output: "line one\nline two",
                outputTruncated: true
            })
        ];
        const strip = createLoadedStrip(planState({ todo: todo() }), jobs);
        const summary = findChild(strip, "workJobsSummary");
        const toggle = findChild(strip, "workJobsToggle");
        compare(summary.text, "Jobs · 2 running · 1 done");

        mouseClick(toggle, toggle.width / 2, toggle.height / 2);
        verify(strip.jobsExpanded);
        toggle.forceActiveFocus();
        keyClick(Qt.Key_Space);
        verify(!strip.jobsExpanded);
        keyClick(Qt.Key_Return);
        verify(strip.jobsExpanded);
        const doneRow = findChild(strip, "workJobRow-done");
        waitForRendering(doneRow);
        mouseClick(doneRow, doneRow.width / 2, doneRow.height / 2);
        verify(strip.outputExpanded("done"));
        doneRow.forceActiveFocus();
        keyClick(Qt.Key_Space);
        verify(!strip.outputExpanded("done"));
        keyClick(Qt.Key_Return);
        const output = findChild(strip, "workJobOutput-done");
        compare(output.text, "line one\nline two");
        compare(output.maximumLineCount, 12);
        compare(strip.duration(1200), "1.2s");
        compare(strip.duration(45000), "45s");
        compare(strip.duration(190000), "3m 10s");

        const cancel = findChild(strip, "workJobCancel-running-b");
        cancel.forceActiveFocus();
        keyClick(Qt.Key_Enter);
        compare(requests.length, 3);
        verify(requests[2].url.endsWith("/jobs/running-b/cancel"));
        requests[2].complete(200, {
            outcome: "cancelled",
            job: job("running-b", "cancelled", {
                endedAt: "2026-08-28T10:00:45.000Z",
                durationMs: 45000
            })
        });
        compare(Ghostd.workJobs[1].id, "running-b");
        compare(Ghostd.workJobs[1].status, "cancelled");
    }

    function test_runningTimerRefetchesAndStopsWhenSettled(): void {
        const running = job("poll", "running", {});
        const strip = createLoadedStrip(planState({ todo: todo() }), [running]);
        const timer = findChild(strip, "workPollTimer");
        verify(timer !== null);
        compare(timer.interval, 3000);
        verify(timer.running);

        timer.triggered();
        tryCompare(requests, "length", 3);
        const jobsRequest = requestEnding("/jobs", 2);
        jobsRequest.complete(200, {
            jobs: [job("poll", "completed", {
                endedAt: "2026-08-28T10:00:01.200Z",
                exitCode: 0
            })]
        });
        tryCompare(timer, "running", false);
    }

    function test_busyPlanMessageIsShownAndStartUsesKeyboard(): void {
        const strip = createLoadedStrip(planState({ todo: todo() }), []);
        const start = findChild(strip, "workPlanStartButton");
        verify(start.visible);
        start.forceActiveFocus();
        keyClick(Qt.Key_Return);
        compare(requests.length, 3);
        compare(requests[2].body, '{"action":"start"}');
        requests[2].complete(409, {
            error: { code: "session_busy", message: "Wait for this answer to finish." }
        });
        const error = findChild(strip, "workErrorLine");
        compare(error.text, "POST plan → 409: Wait for this answer to finish.");
        verify(error.visible);
    }

    function test_streamingDisablesEveryMutation(): void {
        const strip = createLoadedStrip(planState({ plan: approvedPlan(), todo: todo() }), [
            job("running", "running", {})
        ]);
        Ghostd.streaming = true;
        wait(0);
        verify(!findChild(strip, "workPlanOpenButton").enabled);
        verify(!findChild(strip, "workPlanClearButton").enabled);
        findChild(strip, "workJobsToggle").forceActiveFocus();
        keyClick(Qt.Key_Enter);
        verify(!findChild(strip, "workJobCancel-running").enabled);
    }

    function test_turnEndRefreshesOnlyWhileHudIsShown(): void {
        const strip = createLoadedStrip(planState({ todo: todo() }), []);
        Ghostd.turnFinished("casper", "done");
        tryCompare(requests, "length", 4);
        Ghostd.hudVisible = false;
        requestEnding("/plan", 2).complete(200, planState({ todo: todo() }));
        requestEnding("/jobs", 2).complete(200, { jobs: [] });
        Ghostd.turnFinished("casper", "done again");
        wait(0);
        compare(requests.length, 4);
        verify(strip.visible);
    }

    function test_sessionSwitchAbortsBothFetchesAndRejectsOldReplies(): void {
        const strip = createTemporaryObject(stripComponent, tc);
        verify(strip !== null);
        tryCompare(requests, "length", 2);
        const oldPlan = requestEnding("/plan", 0);
        const oldJobs = requestEnding("/jobs", 0);

        Ghostd.sessionIds = ({ casper: "pi:work-strip-next" });
        Ghostd.currentSessionId = "pi:work-strip-next";
        verify(oldPlan.aborted);
        verify(oldJobs.aborted);
        tryCompare(requests, "length", 4);
        verify(requests[2].url.indexOf("pi%3Awork-strip-next") >= 0);
        verify(requests[3].url.indexOf("pi%3Awork-strip-next") >= 0);

        oldPlan.complete(200, planState({ planning: true, todo: todo() }));
        oldJobs.complete(200, { jobs: [job("stale", "running", {})] });
        compare(Ghostd.workSessionId, "pi:work-strip-next");
        verify(!Ghostd.workPlanning);
        compare(Ghostd.workJobs.length, 0);
    }
}
