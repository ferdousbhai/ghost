.pragma library

// Where the workbench sends a file when the user asks for a real editor, and
// which argv gets it there.
//
// Two decisions live here and both are pure, so a test can prove them without a
// filesystem, a process, or an Omarchy install. Everything that touches the
// disk — the `.git` probes, the PATH lookups, reading Omarchy's editor default —
// stays with the caller and arrives here as plain strings plus an injected
// `exists(path)` predicate.
//
// `exists(path)` must answer for a **readable regular file**, not for any
// directory entry. Quickshell exposes no stat, so that is the only question its
// filesystem primitive can answer, and the `.git` walk below is written around
// the limit rather than pretending otherwise.

var LAUNCHER = "omarchy-launch-editor";

/**
 * Folder-aware GUI editors, and how each takes "this project, that file".
 * `goto` is VS Code's `<dir> --goto <file>`; `pair` is the two-argument form
 * Zed and Sublime accept. Anything not listed goes to Omarchy's launcher, which
 * knows how to wrap a terminal editor and how to hand a GUI one to uwsm.
 */
var GUI_EDITORS = {
    "code": "goto",
    "cursor": "goto",
    "zeditor": "pair",
    "sublime_text": "pair"
};

function parentOf(path) {
    var value = String(path || "");
    var cut = value.lastIndexOf("/");
    if (cut < 0) return "";
    return cut === 0 ? "/" : value.slice(0, cut);
}

function isUnder(path, dir) {
    if (typeof path !== "string" || typeof dir !== "string") return false;
    if (path === "" || dir === "") return false;
    if (path === dir) return true;
    var prefix = dir === "/" ? "/" : dir + "/";
    return path.slice(0, prefix.length) === prefix;
}

/**
 * The project directory `filePath` belongs to.
 *
 * Nearest `.git` ancestor wins, because a nested repository is a project in its
 * own right. A `.git` **directory** is spotted by its `HEAD` — a directory is
 * not a readable file, so it cannot be probed for itself — and a worktree's or
 * submodule's `.git` **file** by being readable on its own. Between them the
 * two probes cover every layout git actually produces.
 *
 * The walk never rises above `$HOME` for a file that lives under it: a `.git`
 * in `/home` or `/` is somebody's accident, and opening an editor on it would
 * be a surprise measured in gigabytes. `$HOME` itself is still a candidate, so
 * a dotfiles repo works. A file outside `$HOME` walks up to the top-level
 * directories but never offers `/` itself.
 *
 * With no repository anywhere: the ghost home when the file is inside it (docs
 * and memory are one project), otherwise the file's own directory.
 */
function projectRoot(filePath, ghostHome, userHome, exists) {
    var file = String(filePath || "");
    if (file.charAt(0) !== "/") return "";

    var dir = parentOf(file);
    if (dir === "") return "";

    var home = String(userHome || "");
    var ceiling = (home !== "" && isUnder(dir, home)) ? home : "";

    for (var current = dir; current !== "" && current !== "/"; current = parentOf(current)) {
        if (exists(current + "/.git/HEAD") || exists(current + "/.git")) return current;
        if (current === ceiling) break;
    }

    var ghost = String(ghostHome || "");
    if (ghost !== "" && isUnder(file, ghost)) return ghost;
    return dir;
}

/**
 * The editor named by Omarchy's defaults file, given its contents verbatim.
 * Absent, empty, or unreadable means `nvim`, which is what
 * omarchy-launch-editor falls back to. Only the first line's first word counts;
 * this is a one-word file and a second word would land in argv as a filename.
 */
function editorSetting(defaultsText) {
    var first = String(defaultsText || "").split("\n")[0].trim();
    if (first === "") return "nvim";
    var token = first.split(/\s+/u)[0];
    return token === "" ? "nvim" : token;
}

function guiArgv(setting, root, filePath) {
    var name = String(setting || "");
    var cut = name.lastIndexOf("/");
    // Omarchy cases on the basename but launches the string as written, so a
    // configured `/opt/foo/bin/code` is both recognised and run as given.
    var base = cut < 0 ? name : name.slice(cut + 1);
    if (!Object.prototype.hasOwnProperty.call(GUI_EDITORS, base)) return [];
    return GUI_EDITORS[base] === "goto"
        ? [name, root, "--goto", filePath]
        : [name, root, filePath];
}

/**
 * How to open `filePath` with `root` as the project.
 *
 * `{ command: [], workingDirectory: "" }` means no editor this machine can
 * offer, and the caller should fall back to the desktop's handler for `root`.
 *
 * The order is Omarchy's answer first, ours last. A GUI editor we can drive
 * precisely is launched directly, so the project opens as a workspace with the
 * file focused — something omarchy-launch-editor cannot express, since it
 * passes paths through verbatim. Everything else it *can* handle (terminal
 * editors, editors we have no flags for) goes to it with the project as the
 * working directory. Only a machine with no launcher at all falls through to a
 * bare `code`, which keeps this package usable off Omarchy.
 */
function launchPlan(defaultsText, hasLauncher, hasCode, root, filePath) {
    var gui = guiArgv(editorSetting(defaultsText), root, filePath);
    if (gui.length > 0) return { command: gui, workingDirectory: "" };
    if (hasLauncher) return { command: [LAUNCHER, filePath], workingDirectory: root };
    if (hasCode) return { command: ["code", root, "--goto", filePath], workingDirectory: "" };
    return { command: [], workingDirectory: "" };
}

function onPath(pathEnv, name, exists) {
    var entries = String(pathEnv || "").split(":");
    for (var index = 0; index < entries.length; index += 1) {
        var dir = entries[index];
        // A relative PATH entry is resolved against a working directory this
        // process does not share with the user's shell, so it can only mislead.
        if (dir === "" || dir.charAt(0) !== "/") continue;
        while (dir.length > 1 && dir.charAt(dir.length - 1) === "/") dir = dir.slice(0, -1);
        if (exists((dir === "/" ? "" : dir) + "/" + name)) return true;
    }
    return false;
}
