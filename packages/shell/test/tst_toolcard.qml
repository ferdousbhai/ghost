import QtQuick
import QtTest
import "../qml/services"
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

    function test_legacyNoteCallStaysInGhostHome(): void {
        const activity = {
            name: "ghost_notes_write",
            status: "complete",
            arguments: { path: "projects/roadmap.md" },
            intent: "",
            summary: ""
        };
        compare(ToolTrace.fileTarget(activity), "docs/projects/roadmap.md");
        compare(ToolTrace.fileBase(activity), "ghost");
    }

    function test_nativeWriterUsesItsCapturedCwd(): void {
        const activity = {
            name: "write",
            status: "complete",
            cwd: "/home/owner/projects/one",
            arguments: { path: "notes/today.md" },
            intent: "",
            summary: ""
        };
        const view = ToolTrace.view(activity, true, false, false);
        compare(view.fileBase, "cwd");
        compare(view.fileCwd, "/home/owner/projects/one");
        compare(
            Workbench.absoluteFrom(view.fileTarget, view.fileCwd),
            "/home/owner/projects/one/notes/today.md"
        );
    }

    function test_relativeNativeWriterWithoutRecordedCwdIsRefused(): void {
        compare(Workbench.absoluteFrom("notes/today.md", ""), "");
        // Absolute historical arguments remain unambiguous without the new field.
        compare(Workbench.absoluteFrom("/srv/archive/today.md", ""),
            "/srv/archive/today.md");
    }

    function test_resolutionUsesTheCallCwdNotCurrentGhostOrLaterCd(): void {
        compare(Workbench.absoluteFrom("same.md", "/home/owner"),
            "/home/owner/same.md");
        compare(Workbench.absoluteFrom("same.md", "/home/owner/code/project"),
            "/home/owner/code/project/same.md");
        compare(Workbench.absoluteFrom("../shared.md", "/home/owner/code/project"),
            "/home/owner/code/shared.md");
    }

    function test_desktopToolsSayWhatTheyDid(): void {
        const look = { name: "desktop_look", status: "completed", arguments: { window: "firefox", image: true }, intent: "", summary: "" };
        compare(ToolTrace.text(look, true, false, false), "Checked what’s on screen");
        const ui = { name: "desktop_look", status: "running", arguments: { window: "firefox", ui: true }, intent: "", summary: "" };
        compare(ToolTrace.text(ui, false, false, false), "Looking through a window");
        const one = { name: "desktop_act", status: "completed", arguments: { steps: [{ do: "launch", command: "foot" }] }, intent: "", summary: "" };
        compare(ToolTrace.text(one, true, false, false), "Opened an app");
        const many = { name: "desktop_act", status: "running", arguments: { steps: [{ do: "click" }, { do: "type" }] }, intent: "", summary: "" };
        compare(ToolTrace.text(many, false, false, false), "Working on the desktop");
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

    // The runtime does most of its work through its own coding tools; each
    // reads as one sentence whether it is still running or finished.
    function test_nativeToolsDescribeTheirWork(): void {
        function trace(name, args, completed) {
            return ToolTrace.text(
                { name: name, status: "running", arguments: args, intent: "", summary: "" },
                completed === true, false, false);
        }
        compare(trace("read", { path: "docs/design.md" }), "Reading docs/design.md");
        compare(trace("read", { path: "docs/design.md" }, true), "Read docs/design.md");
        compare(trace("bash", { command: "pnpm test" }), "Running pnpm test");
        compare(trace("grep", { pattern: "retry" }), "Searching for “retry”");
        compare(trace("find", { pattern: "*.qml" }), "Looking for files matching “*.qml”");
        compare(trace("write", { path: "notes.md" }), "Writing notes.md");
        compare(trace("edit", { path: "notes.md" }), "Editing notes.md");
        compare(ToolTrace.fileTarget({ name: "edit", arguments: { path: "notes.md" } }),
            "notes.md");
        compare(ToolTrace.fileBase({ name: "edit", arguments: { path: "notes.md" } }), "cwd");
    }

    // Harnesses spell the same tools their own way; Claude Code's are capitalised
    // and name the file `file_path`.
    function test_harnessSpellingsDescribeTheSameWork(): void {
        function trace(name, args) {
            return ToolTrace.text(
                { name: name, status: "complete", arguments: args, intent: "", summary: "" },
                true, false, false);
        }
        compare(trace("Read", { file_path: "/tmp/notes.md" }), "Read /tmp/notes.md");
        compare(trace("Bash", { command: "ls" }), "Ran ls");
        compare(ToolTrace.fileTarget({ name: "Write", arguments: { file_path: "/tmp/a.md" } }),
            "/tmp/a.md");
    }

    // A file's own bytes coming back as the "summary" says less than the
    // sentence naming the file. A failure still speaks for itself.
    function test_rawContentNeverOutranksTheSentence(): void {
        const read = {
            name: "read",
            status: "complete",
            arguments: { path: "docs/design.md" },
            intent: "",
            summary: "# design\nthe whole file, verbatim"
        };
        compare(ToolTrace.text(read, true, false, false), "Read docs/design.md");
        const failed = Object.assign({}, read, { summary: "docs/design.md does not exist" });
        compare(ToolTrace.text(failed, false, true, false), "docs/design.md does not exist");
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
