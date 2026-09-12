import QtQuick
import QtTest
import qs.components
import qs.services

TestCase {
    id: tc
    name: "ActivityLine"
    when: windowShown
    width: 600
    height: 200
    visible: true

    Component {
        id: lineComponent
        ActivityLine { width: 560 }
    }

    function cleanup(): void {
        Ghostd.streaming = false;
        Ghostd.activity = "";
        Ghostd.toolActivities = [];
        Ghostd.lastError = "";
    }

    function tool(name, status, args): var {
        return {
            id: "tool-" + name, name: name, status: status,
            arguments: args, cwd: "", summary: "", intent: "", askSettled: ""
        };
    }

    // The line reports the work; it never invents a phrase for it. Each rung of
    // the ladder gives way to the one above it the moment that one is true.
    function test_realActivityOutranksEveryPlainerState(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;

        Ghostd.activity = "thinking";
        compare(line.phrase, "Thinking");

        Ghostd.toolActivities = [tool("Read", "running", { file_path: "docs/design.md" })];
        compare(line.phrase, "Reading docs/design.md");

        // The call settles and there is nothing left to name.
        Ghostd.toolActivities = [tool("Read", "complete", { file_path: "docs/design.md" })];
        Ghostd.activity = "";
        compare(line.phrase, "Working");
    }

    // A turn's own tool events clear `activity` between every lifecycle step,
    // which is what used to make the copy flicker. The call itself is the
    // steady thing, so it holds the line for the whole of its run.
    function test_theLineHoldsAcrossOneCallsLifecycle(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        const args = { file_path: "notes.md" };

        Ghostd.toolActivities = [tool("Write", "preparing", ({}))];
        compare(line.phrase, "Writing a file");
        Ghostd.toolActivities = [tool("Write", "queued", args)];
        Ghostd.activity = "";
        compare(line.phrase, "Writing notes.md");
        Ghostd.toolActivities = [tool("Write", "running", args)];
        compare(line.phrase, "Writing notes.md");
    }

    // Parallel calls settle in any order; the newest one is the one running now.
    function test_theNewestOpenCallIsTheOneReported(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        Ghostd.toolActivities = [
            tool("Read", "complete", { file_path: "docs/design.md" }),
            tool("Grep", "running", { pattern: "retry" })
        ];
        compare(line.phrase, "Searching for “retry”");
    }

    function test_aModelFallbackSaysWhichModelItCrossedTo(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        Ghostd.activity = "switching model · claude-sonnet-5";
        compare(line.phrase, "Switching to claude-sonnet-5");
        Ghostd.activity = "using fallback · claude-sonnet-5";
        compare(line.phrase, "Falling back to claude-sonnet-5");
    }

    function test_aFailedTurnShowsItsErrorInsteadOfActivity(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = false;
        Ghostd.lastError = "ghostd is not answering";
        verify(line.visible);
        verify(line.failing);
    }
}
