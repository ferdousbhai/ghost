pragma Singleton

// Workbench — which file the HUD has open beside the chat.
//
// The pane that renders it is qs.components/FilePane, and that pane owns the
// file's *contents* — every read and write of the open file is its FileView,
// not ours. `filePath` is always absolute once set, so every consumer can treat
// it as a real path rather than re-deriving a base.
//
// Ghost-owned context paths are relative to the active ghost home. Model tool
// paths are different: their activity carries the cwd in effect when the call
// ran, and ToolCard supplies that base explicitly. Keeping those two bases
// separate is what lets `!cd` move a conversation without making character.md
// or memory follow it.
//
// The one thing here that does touch the disk is "open this in a real editor",
// at the bottom: answering it means asking the filesystem where the project
// starts. It is click-driven and reads nothing but tiny files.
import Quickshell
import Quickshell.Io
import QtQuick
import "."
import "EditorPolicy.js" as Editor

Singleton {
    id: root

    property string filePath: ""

    readonly property string fileName: root.baseName(root.filePath)

    readonly property string kind: root.kindOf(root.filePath)

    readonly property string home: {
        const ghost = Ghostd.activeGhost;
        if (ghost === "") return "";
        for (const row of (Ghostd.ghosts || [])) {
            if (row && row.name === ghost) return String(row.dir || "");
        }
        return "";
    }

    /**
     * Extensions the code view claims. Curated rather than "anything that is
     * not markdown": an unlisted extension reads as `kind === ""`, which is how
     * a caller knows not to offer the file at all.
     */
    readonly property var codeExtensions: [
        "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "qml", "json", "jsonc",
        "sh", "bash", "zsh", "fish", "css", "scss", "html", "htm", "yaml",
        "yml", "toml", "rs", "go", "c", "h", "cpp", "hpp", "cc", "java", "kt",
        "rb", "lua", "sql", "xml", "svg", "conf", "ini", "env", "txt", "log",
        "csv", "diff", "patch", "nix", "vim", "php", "pl", "swift", "gradle",
        "cmake", "make", "dockerfile", "gitignore", "qmldir"
    ]

    /**
     * Open `path` beside the chat. Absolute or ghost-home-relative. A path no
     * pane can render is ignored rather than opened blank, so `filePath` is
     * always something `kind` describes.
     */
    function open(path: string): void {
        if (!root.canOpen(path)) return;
        root.filePath = root.absolute(path);
    }

    function close(): void {
        root.filePath = "";
    }

    function canOpen(path: string): bool {
        const resolved = root.absolute(path);
        return resolved !== "" && root.kindOf(resolved) !== "";
    }

    function canOpenFrom(path: string, base: string): bool {
        const resolved = root.absoluteFrom(path, base);
        return resolved !== "" && root.kindOf(resolved) !== "";
    }

    /**
     * `path` as an absolute, dot-free path, or "" when it cannot be made one.
     * Accepts a file:// URL and a leading `~` because both reach us from
     * outside; anything else relative needs `home` to be known.
     */
    function absolute(path: string): string {
        return root.absoluteFrom(path, root.home);
    }

    /**
     * Resolve `path` against one explicit absolute directory. Absolute paths
     * and `~` do not need a base; a relative path with no trustworthy base is
     * deliberately refused rather than guessed from the active ghost.
     */
    function absoluteFrom(path: string, base: string): string {
        let value = String(path || "").trim();
        if (value === "") return "";
        // A pseudo-path (conflict://N and friends) names no file on disk.
        if (value.indexOf("://") >= 0 && !value.startsWith("file://")) return "";
        if (value.startsWith("file://")) value = value.slice(7);
        if (value.startsWith("~/") || value === "~") {
            const userHome = Quickshell.env("HOME") || "";
            if (userHome === "") return "";
            value = userHome + value.slice(1);
        }
        if (!value.startsWith("/")) {
            const directory = String(base || "").trim();
            if (directory === "" || !directory.startsWith("/")) return "";
            value = directory + "/" + value;
        }
        const segments = [];
        for (const segment of value.split("/")) {
            if (segment === "" || segment === ".") continue;
            if (segment === "..") {
                segments.pop();
                continue;
            }
            segments.push(segment);
        }
        return segments.length === 0 ? "" : "/" + segments.join("/");
    }

    function baseName(path: string): string {
        const value = String(path || "");
        const cut = value.lastIndexOf("/");
        return cut < 0 ? value : value.slice(cut + 1);
    }

    function kindOf(path: string): string {
        const name = root.baseName(path);
        const dot = name.lastIndexOf(".");
        // `dot > 0` and not `>= 0`: a dotfile is its own name, not an extension.
        const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
        if (ext === "md" || ext === "markdown") return "markdown";
        return root.codeExtensions.indexOf(ext) >= 0 ? "code" : "";
    }

    //
    // Three constraints, all measured against Quickshell 0.3.0 rather than
    // assumed, because every one of them is silent when you get it wrong:
    //
    //  1. There is no stat in the QML API. FileView is the only filesystem
    //     primitive and it reads *files*, so "exists" here can only ever mean
    //     "a readable regular file" — a directory fails the read. EditorPolicy's
    //     `.git` walk is written around that.
    //  2. A FileView will not re-read on a plain `path` assignment once it holds
    //     a file: it hands back the *previous* file's text. Clearing `path`
    //     first makes each probe a real read.
    //  3. The `loaded` property is no answer either — it stays true from the
    //     last successful read, including when the new path is a directory. The
    //     loaded/loadFailed signals are the answer, and with `blockLoading` they
    //     fire inside the `text()` call rather than an event loop later.

    property bool readOk: false

    /** How the PATH answered, once: -1 unknown, 0 no, 1 yes. A machine does
        not gain or lose Omarchy between two clicks. */
    property int launcherFound: -1
    property int codeFound: -1

    /**
     * The text of `path`, or "" when it cannot be read — `readOk` tells an
     * empty file from a missing one. Blocking, so only ever call it from a
     * click, and only on files small enough that nobody notices.
     */
    function read(path: string): string {
        root.readOk = false;
        if (path === "" || !path.startsWith("/")) return "";
        probe.path = "";
        probe.path = path;
        return probe.text();
    }

    function exists(path: string): bool {
        root.read(path);
        return root.readOk;
    }

    function projectRoot(path: string): string {
        const file = root.absolute(path);
        if (file === "") return "";
        return Editor.projectRoot(file, root.home, Quickshell.env("HOME") || "",
            probed => root.exists(probed));
    }

    /**
     * Open `path` in the user's editor with its project as the workspace.
     *
     * The workbench pane is deliberately left as it is: this is a second window
     * onto the same file, not a handoff, and FilePane's own FileView keeps the
     * two in step from here.
     */
    function openInEditor(path: string): void {
        const file = root.absolute(path);
        if (file === "") return;
        const project = root.projectRoot(file);
        // Re-read per click rather than cached: the user can change their
        // editor from Omarchy's menu between one click and the next. The path
        // is $HOME-relative and not XDG_STATE_HOME-relative because that is
        // what omarchy-launch-editor itself reads.
        const defaults = root.read(root.absolute("~/.local/state/omarchy/defaults/editor"));
        const plan = Editor.launchPlan(defaults, root.hasLauncher(), root.hasCode(),
            project, file);
        if (plan.command.length === 0) {
            // Nothing here can open a file at a line. The desktop's own handler
            // for the project directory still beats doing nothing.
            ExternalLinks.openPath(project);
            return;
        }
        // Detached, so a HUD that outlives the editor never reaps it and an
        // editor that outlives the HUD is not killed with it.
        Quickshell.execDetached(plan.workingDirectory === ""
            ? ({ command: plan.command })
            : ({ command: plan.command, workingDirectory: plan.workingDirectory }));
    }

    function hasLauncher(): bool {
        if (root.launcherFound < 0) {
            root.launcherFound = Editor.onPath(Quickshell.env("PATH") || "",
                Editor.LAUNCHER, probed => root.exists(probed)) ? 1 : 0;
        }
        return root.launcherFound === 1;
    }

    // Probing PATH reads the candidate file, which is only reasonable because
    // every distribution's `code` on PATH is a small wrapper script, and because
    // the answer is kept for the life of the shell.
    function hasCode(): bool {
        if (root.codeFound < 0) {
            root.codeFound = Editor.onPath(Quickshell.env("PATH") || "", "code",
                probed => root.exists(probed)) ? 1 : 0;
        }
        return root.codeFound === 1;
    }

    FileView {
        id: probe

        blockLoading: true
        printErrors: false

        onLoaded: root.readOk = true
        onLoadFailed: root.readOk = false
    }
}
