import QtTest
import "../qml/components/ToolTrace.js" as ToolTrace

TestCase {
    name: "ToolTrace"

    function test_liveIntentWinsOverMechanism(): void {
        const activity = {
            name: "ghost_browser",
            status: "running",
            arguments: { action: "find", query: "train times" },
            intent: "Checking whether the last train still runs",
            summary: ""
        };
        const trace = ToolTrace.text(activity, false, false, false);
        compare(trace, "Checking whether the last train still runs");
        verify(!trace.includes("browser"));
    }

    function test_liveSummaryBecomesOutcome(): void {
        const activity = {
            name: "ghost_notes_grep",
            status: "complete",
            arguments: { query: "launch" },
            intent: "Find the launch plan",
            summary: "Found the plan in roadmap.md"
        };
        compare(ToolTrace.text(activity, true, false, false), "Found the plan in roadmap.md");
    }

    function test_restoredCallUsesHumanFallback(): void {
        const activity = {
            name: "ghost_notes_read",
            status: "complete",
            arguments: { path: "projects/roadmap.md" },
            intent: "",
            summary: ""
        };
        compare(ToolTrace.text(activity, true, false, false), "Read projects/roadmap.md");
    }

    function test_failureKeepsPurpose(): void {
        const activity = {
            name: "ghost_browser",
            status: "failed",
            arguments: { action: "open", url: "https://example.com" },
            intent: "",
            summary: ""
        };
        compare(
            ToolTrace.text(activity, false, true, false),
            "Couldn’t complete: Opening https://example.com"
        );
    }

    function test_unknownCallStaysOutOfTheTranscript(): void {
        const activity = {
            name: "internal_operation",
            status: "running",
            arguments: ({}),
            intent: "",
            summary: ""
        };
        compare(ToolTrace.text(activity, false, false, false), "");
    }
}
