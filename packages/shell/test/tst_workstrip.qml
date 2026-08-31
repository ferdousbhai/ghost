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

    function createLoadedStrip(jobs: var): var {
        const strip = createTemporaryObject(stripComponent, tc);
        verify(strip !== null);
        tryCompare(requests, "length", 1);
        const jobsRequest = requestEnding("/jobs", 0);
        verify(jobsRequest !== null);
        jobsRequest.complete(200, { jobs: jobs || [] });
        wait(0);
        if (strip.visible) waitForRendering(strip);
        return strip;
    }

    function init(): void {
        Ghostd.hudVisible = false;
        Ghostd.clearWork();
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
    }

    function test_hiddenWhenAllWorkIsEmpty(): void {
        const strip = createLoadedStrip([]);
        verify(!strip.visible);
        compare(strip.implicitHeight, 0);
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
        const strip = createLoadedStrip(jobs);
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
        const cancelRequest = requestEnding("/jobs/running-b/cancel", 1);
        verify(cancelRequest !== null);
        cancelRequest.complete(200, {
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
        const strip = createLoadedStrip([running]);
        const timer = findChild(strip, "workPollTimer");
        verify(timer !== null);
        compare(timer.interval, 3000);
        verify(timer.running);

        const requestCount = requests.length;
        timer.triggered();
        tryCompare(requests, "length", requestCount + 1);
        const jobsRequest = requestEnding("/jobs", requestCount);
        jobsRequest.complete(200, {
            jobs: [job("poll", "completed", {
                endedAt: "2026-08-28T10:00:01.200Z",
                exitCode: 0
            })]
        });
        tryCompare(timer, "running", false);
    }

    function test_streamingDisablesJobCancellation(): void {
        const strip = createLoadedStrip([job("running", "running", {})]);
        Ghostd.streaming = true;
        wait(0);
        findChild(strip, "workJobsToggle").forceActiveFocus();
        keyClick(Qt.Key_Enter);
        verify(!findChild(strip, "workJobCancel-running").enabled);
    }

    function test_turnEndRefreshesOnlyWhileHudIsShown(): void {
        const strip = createLoadedStrip([]);
        Ghostd.turnFinished("casper", "done");
        tryCompare(requests, "length", 2);
        Ghostd.hudVisible = false;
        requestEnding("/jobs", 1).complete(200, { jobs: [] });
        Ghostd.turnFinished("casper", "done again");
        wait(0);
        compare(requests.length, 2);
        verify(!strip.visible);
    }

    function test_sessionSwitchAbortsFetchAndRejectsOldReply(): void {
        const strip = createTemporaryObject(stripComponent, tc);
        verify(strip !== null);
        tryCompare(requests, "length", 1);
        const oldJobs = requestEnding("/jobs", 0);

        Ghostd.sessionIds = ({ casper: "pi:work-strip-next" });
        Ghostd.currentSessionId = "pi:work-strip-next";
        verify(oldJobs.aborted);
        tryCompare(requests, "length", 2);
        verify(requests[1].url.indexOf("pi%3Awork-strip-next") >= 0);

        oldJobs.complete(200, { jobs: [job("stale", "running", {})] });
        compare(Ghostd.workSessionId, "pi:work-strip-next");
        compare(Ghostd.workJobs.length, 0);
    }
}
