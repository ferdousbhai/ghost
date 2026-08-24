import QtQuick
import QtTest
import "../qml/services/EditorPolicy.js" as Editor

// The workbench's "open in editor" button, minus the two things a test cannot
// have: a filesystem laid out as somebody's home directory, and an Omarchy
// install. Both arrive in the policy as data — a list of paths that exist, and
// the literal contents of Omarchy's editor-defaults file — which is the reason
// the policy takes an injected `exists` probe rather than reaching for a
// FileView. qmltestrunner cannot load Quickshell's plugin at all (its Io module
// lives inside the quickshell binary), so a fixture-on-disk version of these
// tests could not run here even if it were nicer.
TestCase {
    id: tc
    name: "EditorPolicy"

    /** An `exists` probe over a fixed list of readable regular files. */
    function probe(files) {
        return function (path) { return files.indexOf(path) >= 0; };
    }

    function test_projectRoot_data() {
        const home = "/home/u";
        const ghost = "/home/u/.local/share/ghost/casper";
        return [
            {
                tag: "a .git directory ancestor",
                file: "/home/u/work/app/src/main.js",
                files: ["/home/u/work/app/.git/HEAD"],
                root: "/home/u/work/app"
            },
            {
                tag: "a .git file ancestor (worktree)",
                file: "/home/u/work/app/src/main.js",
                files: ["/home/u/work/app/.git"],
                root: "/home/u/work/app"
            },
            {
                tag: "nested repo picks the nearest",
                file: "/home/u/work/outer/inner/src/main.js",
                files: ["/home/u/work/outer/.git/HEAD", "/home/u/work/outer/inner/.git/HEAD"],
                root: "/home/u/work/outer/inner"
            },
            {
                tag: "the file's own directory is the repo",
                file: "/home/u/work/app/main.js",
                files: ["/home/u/work/app/.git/HEAD"],
                root: "/home/u/work/app"
            },
            {
                tag: "no .git under the ghost home",
                file: "/home/u/.local/share/ghost/casper/docs/idea.md",
                files: [],
                root: ghost
            },
            {
                tag: "the ghost home itself",
                file: "/home/u/.local/share/ghost/casper/MEMORY.md",
                files: [],
                root: ghost
            },
            {
                tag: "no .git outside the ghost home",
                file: "/home/u/scratch/notes/idea.md",
                files: [],
                root: "/home/u/scratch/notes"
            },
            {
                tag: "a repo beats the ghost home",
                file: "/home/u/.local/share/ghost/casper/docs/idea.md",
                files: ["/home/u/.local/share/ghost/casper/docs/.git/HEAD"],
                root: "/home/u/.local/share/ghost/casper/docs"
            },
            {
                tag: "stops at $HOME",
                file: "/home/u/scratch/idea.md",
                files: ["/home/.git/HEAD", "/.git/HEAD"],
                root: "/home/u/scratch"
            },
            {
                tag: "$HOME itself may be the repo",
                file: "/home/u/idea.md",
                files: ["/home/u/.git/HEAD"],
                root: home
            },
            {
                tag: "outside $HOME walks to the top level",
                file: "/srv/code/proj/src/main.js",
                files: ["/srv/code/proj/.git/HEAD"],
                root: "/srv/code/proj"
            },
            {
                tag: "outside $HOME never offers /",
                file: "/srv/main.js",
                files: ["/.git/HEAD"],
                root: "/srv"
            },
            {
                tag: "a relative path resolves to nothing",
                file: "notes/idea.md",
                files: [],
                root: ""
            }
        ];
    }

    function test_projectRoot(data) {
        compare(Editor.projectRoot(data.file, "/home/u/.local/share/ghost/casper",
            "/home/u", tc.probe(data.files)), data.root);
    }

    function test_editorSetting_data() {
        return [
            { tag: "one word", text: "code\n", editor: "code" },
            { tag: "no trailing newline", text: "zeditor", editor: "zeditor" },
            { tag: "surrounding space", text: "  cursor  \n", editor: "cursor" },
            { tag: "only the first line", text: "code\nzeditor\n", editor: "code" },
            { tag: "only the first word", text: "code --wait\n", editor: "code" },
            { tag: "empty file", text: "", editor: "nvim" },
            { tag: "blank file", text: "\n\n", editor: "nvim" },
            { tag: "absent file", text: null, editor: "nvim" }
        ];
    }

    function test_editorSetting(data) {
        compare(Editor.editorSetting(data.text), data.editor);
    }

    function test_launchPlan_data() {
        const root = "/home/u/work/app";
        const file = "/home/u/work/app/src/main.js";
        return [
            {
                tag: "code opens the folder and goes to the file",
                text: "code\n", launcher: true, code: true,
                command: ["code", root, "--goto", file], cwd: ""
            },
            {
                tag: "cursor takes the same flags",
                text: "cursor\n", launcher: true, code: false,
                command: ["cursor", root, "--goto", file], cwd: ""
            },
            {
                tag: "zed takes the pair",
                text: "zeditor\n", launcher: true, code: false,
                command: ["zeditor", root, file], cwd: ""
            },
            {
                tag: "sublime takes the pair",
                text: "sublime_text\n", launcher: true, code: false,
                command: ["sublime_text", root, file], cwd: ""
            },
            {
                tag: "a configured absolute path is run as written",
                text: "/opt/vscode/bin/code\n", launcher: true, code: false,
                command: ["/opt/vscode/bin/code", root, "--goto", file], cwd: ""
            },
            {
                tag: "a terminal editor goes to omarchy's launcher",
                text: "nvim\n", launcher: true, code: true,
                command: ["omarchy-launch-editor", file], cwd: root
            },
            {
                tag: "an editor we have no flags for goes to the launcher",
                text: "kate\n", launcher: true, code: true,
                command: ["omarchy-launch-editor", file], cwd: root
            },
            {
                tag: "an unreadable defaults file goes to the launcher",
                text: "", launcher: true, code: true,
                command: ["omarchy-launch-editor", file], cwd: root
            },
            {
                tag: "off Omarchy, code stands in",
                text: "", launcher: false, code: true,
                command: ["code", root, "--goto", file], cwd: ""
            },
            {
                tag: "off Omarchy with no code, nothing",
                text: "", launcher: false, code: false,
                command: [], cwd: ""
            },
            {
                tag: "a GUI default still wins with no launcher",
                text: "zeditor\n", launcher: false, code: true,
                command: ["zeditor", root, file], cwd: ""
            }
        ];
    }

    function test_launchPlan(data) {
        const plan = Editor.launchPlan(data.text, data.launcher, data.code,
            "/home/u/work/app", "/home/u/work/app/src/main.js");
        compare(plan.command.join(" "), data.command.join(" "));
        compare(plan.workingDirectory, data.cwd);
    }

    function test_onPath_data() {
        return [
            {
                tag: "found",
                path: "/usr/local/bin:/usr/bin",
                files: ["/usr/bin/code"], found: true
            },
            {
                tag: "not found",
                path: "/usr/local/bin:/usr/bin",
                files: ["/opt/bin/code"], found: false
            },
            {
                tag: "trailing slash",
                path: "/usr/bin/",
                files: ["/usr/bin/code"], found: true
            },
            {
                tag: "relative entries are skipped",
                path: ".:bin",
                files: ["./code", "bin/code"], found: false
            },
            {
                tag: "empty entries are skipped",
                path: "::/usr/bin",
                files: ["/usr/bin/code"], found: true
            },
            {
                tag: "root on PATH does not double the slash",
                path: "/",
                files: ["/code"], found: true
            },
            {
                tag: "no PATH at all",
                path: "",
                files: ["/usr/bin/code"], found: false
            }
        ];
    }

    function test_onPath(data) {
        compare(Editor.onPath(data.path, "code", tc.probe(data.files)), data.found);
    }
}
