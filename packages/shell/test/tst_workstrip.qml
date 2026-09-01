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
        WorkStrip { width: 700; height: implicitHeight }
    }

    function fakeRequest(): var {
        const xhr = {
            readyState: 0, status: 0, responseText: "", method: "", url: "",
            body: null, aborted: false, headers: ({}), onreadystatechange: null,
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

    function createLoadedStrip(jobs: var): var {
        const strip = createTemporaryObject(stripComponent, tc);
        verify(strip !== null);
        tryCompare(requests, "length", 1);
        verify(requests[0].url.endsWith("/jobs"));
        requests[0].complete(200, { jobs: jobs || [] });
        wait(0);
        if (strip.visible) waitForRendering(strip);
        return strip;
    }

    function lastRequestEnding(suffix: string): var {
        for (let index = requests.length - 1; index >= 0; index -= 1) {
            if (requests[index].url.endsWith(suffix)) return requests[index];
        }
        return null;
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

    function test_hiddenWhenJobsAreEmpty(): void {
        const strip = createLoadedStrip([]);
        verify(!strip.visible);
        compare(strip.implicitHeight, 0);
    }

    function test_fetchErrorRemainsVisibleWithoutJobs(): void {
        const strip = createTemporaryObject(stripComponent, tc);
        verify(strip !== null);
        tryCompare(requests, "length", 1);
        requests[0].complete(503, {
            error: { code: "unavailable", message: "Jobs are temporarily unavailable." }
        });
        tryCompare(strip, "visible", true);
        compare(findChild(strip, "workErrorLine").text,
            "GET jobs → 503: Jobs are temporarily unavailable.");
    }

    function test_jobsExpandOutputAndCancelTheRightRow(): void {
        const strip = createLoadedStrip([
            job("running-a", "running", {}),
            job("running-b", "running", { durationMs: 45000 }),
            job("done", "completed", {
                durationMs: 190000,
                endedAt: "2026-08-28T10:03:10.000Z",
                exitCode: 0,
                output: "line one\nline two",
                outputTruncated: true
            })
        ]);
        compare(findChild(strip, "workJobsSummary").text, "Jobs · 2 running · 1 done");
        const toggle = findChild(strip, "workJobsToggle");
        toggle.forceActiveFocus();
        keyClick(Qt.Key_Return);
        verify(strip.jobsExpanded);

        const doneRow = findChild(strip, "workJobRow-done");
        waitForRendering(doneRow);
        mouseClick(doneRow, doneRow.width / 2, doneRow.height / 2);
        compare(findChild(strip, "workJobOutput-done").text, "line one\nline two");
        compare(strip.duration(190000), "3m 10s");

        const cancel = findChild(strip, "workJobCancel-running-b");
        cancel.forceActiveFocus();
        keyClick(Qt.Key_Enter);
        const cancelRequest = lastRequestEnding("/jobs/running-b/cancel");
        verify(cancelRequest !== null);
        cancelRequest.complete(200, {
            outcome: "cancelled",
            job: job("running-b", "cancelled", { durationMs: 45000 })
        });
        compare(Ghostd.workJobs[1].status, "cancelled");
    }

    function test_runningTimerRefetchesAndStopsWhenSettled(): void {
        const strip = createLoadedStrip([job("poll", "running", {})]);
        const timer = findChild(strip, "workPollTimer");
        verify(timer.running);
        timer.triggered();
        const jobsRequest = lastRequestEnding("/jobs");
        verify(jobsRequest !== null);
        jobsRequest.complete(200, {
            jobs: [job("poll", "completed", { exitCode: 0 })]
        });
        tryCompare(timer, "running", false);
    }

    function test_streamingDisablesCancellation(): void {
        const strip = createLoadedStrip([job("running", "running", {})]);
        Ghostd.streaming = true;
        wait(0);
        verify(!findChild(strip, "workJobCancel-running").enabled);
    }

    function test_sessionSwitchAbortsFetchAndRejectsOldReply(): void {
        const strip = createTemporaryObject(stripComponent, tc);
        verify(strip !== null);
        tryCompare(requests, "length", 1);
        const oldJobs = requests[0];

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
