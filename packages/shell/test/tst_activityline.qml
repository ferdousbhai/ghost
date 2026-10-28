import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"
import "../qml/components/ToolTrace.js" as ToolTrace

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
        Ghostd.settling = false;
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
        compare(line.phrase, "read docs/design.md");

        // The call settles; between calls the line never replays what came
        // back (pi's convention), so it says the turn is working.
        Ghostd.toolActivities = [tool("read", "complete", { path: "docs/design.md" })];
        Ghostd.activity = "";
        compare(line.phrase, "Working");
        // A failed call is named, with its error.
        Ghostd.toolActivities = [Object.assign(tool("bash", "failed", { command: "pnpm test" }), { summary: "exit 1: 2 tests failed" })];
        compare(line.phrase, "$ pnpm test failed: exit 1: 2 tests failed");
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

    // Before the reply, a turn can be waiting on an owner hook; the line names
    // it rather than a bare "Working", and lets go when it returns.
    function test_aRunningHookIsNamed(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        const state = { activity: "" };

        Ghostd.handleTurnEvent(state, { type: "hook_start", name: "Add context", event: "before_prompt" });
        Ghostd.activity = state.activity;
        compare(line.phrase, "Add context");

        Ghostd.handleTurnEvent(state, { type: "hook_end", name: "Add context", event: "before_prompt" });
        Ghostd.activity = state.activity;
        compare(line.phrase, "Working");
    }

    // A stop hook runs after the reply is complete, so the turn reads as done
    // while it decides; a continuation brings the line back.
    function test_aStopHookRunsOutOfSight(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        const state = Ghostd.newTurnState("", "");
        state.streaming = true;

        Ghostd.handleTurnEvent(state, { type: "hook_start", name: "Keep going?", event: "session_stop" });
        Ghostd.settling = state.settling;
        verify(!Ghostd.working);
        verify(!line.visible);

        Ghostd.handleTurnEvent(state, { type: "hook_end", name: "Keep going?", event: "session_stop" });
        Ghostd.settling = state.settling;
        verify(!line.visible);

        Ghostd.handleTurnEvent(state, { type: "session_stop_continued", reason: "Verify it." });
        Ghostd.settling = state.settling;
        verify(Ghostd.working);
        verify(line.visible);
    }

    // A follow-up queued while the stop hook decides waits for it: the turn
    // stays settled until that follow-up's pass starts.
    function test_queueingDuringAStopHookStaysSettled(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        const state = Ghostd.newTurnState("", "");
        state.streaming = true;

        Ghostd.handleTurnEvent(state, { type: "hook_start", name: "Keep going?", event: "session_stop" });
        Ghostd.handleTurnEvent(state, { type: "queue", followUp: ["and the index"] });
        Ghostd.settling = state.settling;
        verify(!Ghostd.working);
        verify(!line.visible);

        Ghostd.handleTurnEvent(state, { type: "hook_end", name: "Keep going?", event: "session_stop" });
        Ghostd.handleTurnEvent(state, { type: "queue", followUp: [] });
        Ghostd.handleTurnEvent(state, { type: "owner_message", text: "and the index" });
        Ghostd.settling = state.settling;
        verify(Ghostd.working);
    }

    // The running call is the steady thing: it names the line whether the
    // turn's `activity` holds the raw tool name or has been cleared, so the
    // copy does not flicker between them.
    function test_theLineHoldsAcrossOneCallsLifecycle(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;

        Ghostd.toolActivities = [tool("write", "running", ({}))];
        compare(line.phrase, "write …");
        Ghostd.toolActivities = [tool("write", "running", { path: "notes.md" })];
        Ghostd.activity = "write";
        compare(line.phrase, "write notes.md");
        Ghostd.activity = "";
        compare(line.phrase, "write notes.md");
    }

    // pi times a call: after a second the line says how long it has run, and
    // never trails dots after a command.
    function test_aRunningCallShowsHowLongItHasRun(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = true;
        line.now = 100000;
        Ghostd.toolActivities = [Object.assign(tool("bash", "running", { command: "pnpm test" }), { startedAt: 100000 })];
        compare(line.phrase, "$ pnpm test");
        line.now = 104200;
        compare(line.phrase, "$ pnpm test · 4s");
        line.now = 100000 + 75000;
        compare(line.phrase, "$ pnpm test · 1m 15s");
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
        compare(line.phrase, "grep /retry/ in .");
    }

    function test_aFailedTurnShowsItsErrorInsteadOfActivity(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        Ghostd.streaming = false;
        Ghostd.lastError = "ghostd is not answering";
        verify(line.visible);
        verify(line.failing);
    }

    // The line wraps, so a long command reaches it whole; only a one-line
    // surface, a collapsed card, cuts it short.
    function test_aLongCommandIsNotCutShort(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        const command = "pnpm --filter @ghost/daemon test test/stream-lifecycle.test.ts "
            + "test/session-host.test.ts --reporter=verbose --bail 1";
        Ghostd.streaming = true;
        Ghostd.toolActivities = [tool("bash", "running", { command: command })];
        compare(line.phrase, "$ " + command);
        verify(ToolTrace.text(Ghostd.toolActivities[0], false, false, false).endsWith("…"));
    }

    function test_longStatusWrapsAndCanBeReadToTheEnd(): void {
        const line = createTemporaryObject(lineComponent, tc);
        verify(line !== null);
        line.width = 240;
        Ghostd.lastError = "The command failed while reading the launch draft.\n\n"
            + "The full paragraph explains what happened and where to continue. ".repeat(12);

        const scroll = findChild(line, "phraseScroll");
        verify(scroll !== null);
        verify(line.implicitHeight > 30);
        compare(line.implicitHeight, line.maxHeight);
        verify(scroll.contentHeight > scroll.height);
        scroll.contentY = scroll.contentHeight - scroll.height;
        verify(scroll.contentY > 0);
        line.maxHeight = 90;
        compare(line.implicitHeight, 90);
    }
}
