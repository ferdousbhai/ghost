import QtQuick
import QtTest
import "../qml/services"
import "../qml/components/ToolTrace.js" as ToolTrace

TestCase {
    name: "ToolTrace"

    function test_nativeWriterUsesItsCapturedCwd(): void {
        const activity = {
            name: "write",
            status: "complete",
            cwd: "/home/owner/projects/one",
            arguments: { path: "notes/today.md" },
            summary: ""
        };
        const view = ToolTrace.view(activity, true, false, false);
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

    function test_ghostToolsReadTheSameUnderAnyHarnessNamespace(): void {
        for (const name of ["desktop_look", "mcp__ghost__desktop_look", "ghost.desktop_look"]) {
            const look = { name: name, status: "completed", arguments: { image: true }, summary: "" };
            compare(ToolTrace.text(look, true, false, false), "Checked what’s on screen", name);
        }
    }

    function test_desktopToolsSayWhatTheyDid(): void {
        const look = { name: "desktop_look", status: "completed", arguments: { window: "firefox", image: true }, summary: "" };
        compare(ToolTrace.text(look, true, false, false), "Checked what’s on screen");
        const ui = { name: "desktop_look", status: "running", arguments: { window: "firefox", ui: true }, summary: "" };
        compare(ToolTrace.text(ui, false, false, false), "Looking through a window");
        const one = { name: "desktop_act", status: "completed", arguments: { steps: [{ do: "type", text: "hi" }] }, summary: "" };
        compare(ToolTrace.text(one, true, false, false), "Typed on the desktop");
        const many = { name: "desktop_act", status: "running", arguments: { steps: [{ do: "click" }, { do: "type" }] }, summary: "" };
        compare(ToolTrace.text(many, false, false, false), "Working on the desktop");
    }

    // pi's convention: a call is shown as itself, what it does, never as what
    // came back. Running or finished, the line is the same.
    function test_callsReadTheWayPiShowsThem(): void {
        function call(name, args, extra) {
            return ToolTrace.text(Object.assign({ name: name, status: "running", arguments: args, summary: "" },
                extra || ({})), false, false, false);
        }
        compare(call("bash", { command: "pnpm test" }), "$ pnpm test");
        compare(call("read", { path: "docs/design.md" }), "read docs/design.md");
        compare(call("read", { path: "docs/design.md", offset: 10, limit: 31 }), "read docs/design.md:10-40");
        compare(call("write", { path: "notes.md" }), "write notes.md");
        compare(call("edit", { path: "notes.md" }), "edit notes.md");
        compare(call("ls", ({})), "ls .");
        compare(call("grep", { pattern: "retry", path: "src", glob: "*.ts" }), "grep /retry/ in src (*.ts)");
        compare(call("find", { pattern: "*.qml" }), "find *.qml in .");
        compare(ToolTrace.fileTarget({ name: "edit", arguments: { path: "notes.md" } }), "notes.md");
    }

    // Each harness spells the same tools its own way.
    function test_harnessSpellingsReadTheSame(): void {
        function call(name, args) {
            return ToolTrace.text({ name: name, status: "complete", arguments: args, summary: "" }, true, false, false);
        }
        compare(call("Read", { file_path: "/tmp/notes.md" }), "read /tmp/notes.md");
        compare(call("Bash", { command: "ls" }), "$ ls");
        // Codex wraps its command; the script is the command.
        compare(call("shell", { command: ["bash", "-lc", "git status"] }), "$ git status");
        compare(call("apply_patch", { input: "*** Begin Patch\n*** Update File: src/app.ts\n@@" }), "edit src/app.ts");
        compare(ToolTrace.fileTarget({ name: "Write", arguments: { file_path: "/tmp/a.md" } }), "/tmp/a.md");
    }

    // Paths read short: inside the call's directory, relative; home as ~.
    function test_pathsReadShort(): void {
        const cwd = "/home/owner/ghosts/casper/sessions/c1";
        compare(ToolTrace.text({ name: "read", arguments: { path: cwd + "/notes.md" }, cwd: cwd }, false, false, false),
            "read notes.md");
        compare(ToolTrace.text({ name: "read", arguments: { path: "/home/owner/.config/hypr/bindings.lua" }, cwd: cwd },
            false, false, false), "read ~/.config/hypr/bindings.lua");
    }

    // What came back is the output, shown on request or when the call failed;
    // it never replaces the call, however informative it looks.
    function test_resultsAreOutputNotTheLine(): void {
        const read = { name: "read", status: "complete", arguments: { path: "docs/design.md" },
            summary: "# design\nthe whole file, verbatim" };
        compare(ToolTrace.text(read, true, false, false), "read docs/design.md");
        const quiet = { name: "bash", status: "complete", arguments: { command: "true" }, summary: "(no output)" };
        compare(ToolTrace.text(quiet, true, false, false), "$ true");
        compare(ToolTrace.output(quiet), "(no output)");
        const failed = { name: "read", status: "failed", arguments: { path: "docs/design.md" },
            summary: "docs/design.md does not exist" };
        compare(ToolTrace.text(failed, false, true, false), "read docs/design.md");
        compare(ToolTrace.output(failed), "docs/design.md does not exist");
    }

    // A tool with no renderer of its own shows its name and arguments, as pi
    // shows one: nothing the ghost does is out of sight.
    function test_anyOtherToolShowsItsNameAndArguments(): void {
        compare(ToolTrace.text({ name: "internal_operation", arguments: ({}) }, false, false, false), "internal_operation");
        compare(ToolTrace.text({ name: "todo", arguments: { action: "add", text: "ship it" } }, false, false, false),
            "todo action: add, text: ship it");
        const long = ToolTrace.text({ name: "fetch", arguments: { url: "https://example.com/" + "x".repeat(200) } },
            false, false, false);
        compare(long.length, 100);
        verify(long.endsWith("…"));
    }
}
