import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

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
            arguments: args, cwd: "", summary: ""
        };
    }

    // The line reports the work; it never invents a phrase for it. Each rung of
    // the ladder gives way to the one above it the moment that one is true.
    function test_realActivityOutranksEveryPlainerState(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;

        Ghostd.activity = "starting:codex";
        compare(line.phrase, "Starting codex");

        Ghostd.activity = "thinking:";
        compare(line.phrase, "Thinking");
        Ghostd.activity = "thinking:**Reading the board**\n\nThe owner wants\n\n**Drafting a reply**\n\nShort";
        compare(line.phrase, "Drafting a reply");
        // Unheaded reasoning is prose; it never lands on the line.
        Ghostd.activity = "thinking:the repo has a clear technical identity: a local omarchy ghost that";
        compare(line.phrase, "Thinking");

        Ghostd.toolActivities = [tool("read", "running", { path: "docs/design.md" })];
        compare(line.phrase, "Reading docs/design.md");

        // The call settles; the line says what was just done until the next
        // step has a name of its own.
        Ghostd.toolActivities = [tool("read", "complete", { path: "docs/design.md" })];
        Ghostd.activity = "";
        compare(line.phrase, "Read docs/design.md");
        Ghostd.toolActivities = [];
        compare(line.phrase, "Working");
    }

    // Reply text streaming is its own state, not a bare "Working".
    function test_writingTheReplyIsNamed(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        const state = { activity: "", parts: [] };

        Ghostd.handleTurnEvent(state, { type: "text_start", contentIndex: 0 });
        Ghostd.activity = state.activity;
        compare(line.phrase, "Writing a reply");
    }

    // After the reply, a turn can still be waiting on an owner hook; the line
    // names it rather than a bare "Working", and lets go when it returns.
    function test_aRunningHookIsNamed(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        const state = { activity: "" };

        Ghostd.handleTurnEvent(state, { type: "hook_start", name: "Deciding whether to keep going" });
        Ghostd.activity = state.activity;
        compare(line.phrase, "Deciding whether to keep going");

        Ghostd.handleTurnEvent(state, { type: "hook_end", name: "Deciding whether to keep going" });
        Ghostd.activity = state.activity;
        compare(line.phrase, "Working");
    }

    // A turn's own tool events clear `activity` between every lifecycle step,
    // which is what used to make the copy flicker. The call itself is the
    // steady thing, so it holds the line for the whole of its run.
    function test_theLineHoldsAcrossOneCallsLifecycle(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        const args = { path: "notes.md" };

        Ghostd.toolActivities = [tool("write", "preparing", ({}))];
        compare(line.phrase, "Writing a file");
        Ghostd.toolActivities = [tool("write", "queued", args)];
        Ghostd.activity = "";
        compare(line.phrase, "Writing notes.md");
        Ghostd.toolActivities = [tool("write", "running", args)];
        compare(line.phrase, "Writing notes.md");
    }

    // Parallel calls settle in any order; the newest one is the one running now.
    function test_theNewestOpenCallIsTheOneReported(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        Ghostd.toolActivities = [
            tool("read", "complete", { path: "docs/design.md" }),
            tool("grep", "running", { pattern: "retry" })
        ];
        compare(line.phrase, "Searching for “retry”");
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
