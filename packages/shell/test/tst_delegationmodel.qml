import QtQuick
import QtTest
import "../qml/services/DelegationModel.js" as DelegationModel

TestCase {
    name: "DelegationModel"

    function task(overrides: var, detailed: bool): var {
        const value = Object.assign({
            id: "task-11111111-1111-4111-8111-111111111111",
            harness: "codex",
            agent: null,
            cwd: "/home/owner/code/ghost",
            state: "running",
            createdAt: "2026-08-31T10:00:00.000Z",
            updatedAt: "2026-08-31T10:00:01.000Z",
            taskPreview: "Run the focused delegation checks.",
            taskTruncated: false,
            resultPreview: null,
            resultTruncated: false,
            error: null
        }, overrides || {});
        if (detailed) {
            value.events = [{
                sequence: 1,
                at: "2026-08-31T10:00:01.000Z",
                code: "started",
                message: "Worker started."
            }];
            value.eventsTruncated = false;
        }
        return value;
    }

    function test_catalogueIsExactSortedAndPrivateFieldsFailClosed(): void {
        const parsed = DelegationModel.catalogue({ harnesses: [
            { id: "pi", availability: "available", authentication: "unknown" },
            { id: "claude-code", availability: "unavailable", authentication: "unknown" },
            { id: "codex", availability: "available", authentication: "authenticated" }
        ] });
        verify(parsed !== null);
        compare(parsed.map(function (row) { return row.id; }).join(","),
            "claude-code,codex,pi");
        compare(DelegationModel.availabilityLabel(parsed[1]), "Ready · signed in");

        const leaking = { harnesses: [{
            id: "pi", availability: "available", authentication: "unknown",
            executable: "/private/pi"
        }, {
            id: "codex", availability: "available", authentication: "unknown"
        }, {
            id: "claude-code", availability: "available", authentication: "unknown"
        }] };
        compare(DelegationModel.catalogue(leaking), null);
        compare(DelegationModel.catalogue({ harnesses: [
            { id: "pi", availability: "available", authentication: "unknown" },
            { id: "pi", availability: "available", authentication: "unknown" },
            { id: "codex", availability: "available", authentication: "unknown" }
        ] }), null);
    }

    function test_listAndDetailEnforceBoundsAndDiscardErrorMessages(): void {
        const list = DelegationModel.listing({
            tasks: [task()], shown: 1, total: 1
        });
        verify(list !== null);
        compare(list.tasks[0].taskPreview, "Run the focused delegation checks.");
        verify(!("message" in list.tasks[0]));

        const failed = task({
            state: "failed",
            error: { code: "adapter_failed", message: "Owner-safe but not shown as raw detail." }
        }, true);
        const detail = DelegationModel.task(failed, true);
        verify(detail !== null);
        verify(detail.failed);
        verify(!("error" in detail));
        compare(DelegationModel.summary(detail),
            "The worker failed safely. Inspect its progress events.");

        const oversized = task({ taskPreview: "x".repeat(241) });
        compare(DelegationModel.task(oversized, false), null);
        const extra = task();
        extra.protocol = { secret: true };
        compare(DelegationModel.task(extra, false), null);
        compare(DelegationModel.task(task({
            harness: "pi",
            agent: "claude-only-agent"
        }), false), null);
    }

    function test_progressOrderingTerminalSummaryAndExactStates(): void {
        const completed = task({
            state: "completed",
            resultPreview: "All focused checks passed.",
            updatedAt: "2026-08-31T10:00:02.000Z"
        }, true);
        completed.events.push({
            sequence: 2,
            at: "2026-08-31T10:00:02.000Z",
            code: "completed",
            message: "Done."
        });
        const parsed = DelegationModel.task(completed, true);
        verify(parsed !== null);
        compare(DelegationModel.summary(parsed), "All focused checks passed.");
        verify(!DelegationModel.active(parsed.state));
        verify(DelegationModel.active("running"));

        const reversed = task({}, true);
        reversed.events.push({
            sequence: 1,
            at: "2026-08-31T10:00:00.500Z",
            code: "progress",
            message: "Out of order."
        });
        compare(DelegationModel.task(reversed, true), null);
        compare(DelegationModel.task(task({ state: "waiting" }), false), null);
    }
}
