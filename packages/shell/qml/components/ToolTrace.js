.pragma library

function compact(value, limit) {
    const oneLine = String(value || "").replace(/\s+/gu, " ").trim();
    return oneLine.length > limit ? oneLine.slice(0, limit - 1) + "…" : oneLine;
}

function argument(activity, key) {
    const args = activity.arguments;
    if (!args || typeof args !== "object") return "";
    return typeof args[key] === "string" ? args[key].trim() : "";
}

function quoted(value, limit) {
    return "“" + compact(value, limit) + "”";
}

/** The file a call names: `path`, or `file_path` in Claude Code's spelling. */
function pathArgument(activity) {
    return argument(activity, "path") || argument(activity, "file_path");
}

/**
 * The tool's name, lowercased: harnesses spell the same tool `Read` or `read`,
 * and the ghost's own tools `mcp__ghost__desktop_look` (Claude) or
 * `ghost.desktop_look` (Codex).
 */
function toolName(activity) {
    return String(activity.name || "").toLowerCase().replace(/^(?:mcp__ghost__|ghost\.)/, "");
}

/**
 * A path as pi shows one: relative to the call's working directory when it
 * lies inside it, the home directory as `~`, otherwise as given.
 */
function shortPath(value, cwd) {
    var path = String(value || "").trim();
    if (path === "") return "";
    if (cwd && path.indexOf(cwd + "/") === 0) path = path.slice(cwd.length + 1);
    return path.replace(/^\/home\/[^/]+(?=\/|$)/u, "~");
}

/**
 * A shell call's command line. Codex sends `["bash", "-lc", "<script>"]`;
 * the script is the command, the wrapper is not.
 */
function shellCommand(activity) {
    var args = activity.arguments || ({});
    var command = args.command !== undefined ? args.command : args.cmd;
    if (Array.isArray(command)) {
        var wrapped = command.length === 3 && /(^|\/)(ba|z)?sh$/u.test(String(command[0]))
            && /^-l?c$/u.test(String(command[1]));
        command = wrapped ? command[2] : command.join(" ");
    }
    return typeof command === "string" ? command.trim() : "";
}

/** `:start` or `:start-end` from a read's offset and limit, as pi prints it. */
function lineRange(activity) {
    var args = activity.arguments || ({});
    if (typeof args.offset !== "number" && typeof args.limit !== "number") return "";
    var start = typeof args.offset === "number" && args.offset > 0 ? args.offset : 1;
    return ":" + start + (typeof args.limit === "number" && args.limit > 0 ? "-" + (start + args.limit - 1) : "");
}

/** The file an edit names; a Codex patch names it in its first file header. */
function editedPath(activity) {
    var path = pathArgument(activity);
    if (path !== "") return path;
    var patch = argument(activity, "input") || argument(activity, "patch");
    var header = /\*\*\* (?:Update|Add|Delete) File: (.+)/u.exec(patch);
    return header ? header[1].trim() : "";
}

/** Every argument, `key: value`, the way pi shows a tool it has no renderer for. */
function genericCall(name, activity, limit) {
    var args = activity.arguments;
    var parts = [];
    if (args && typeof args === "object" && !Array.isArray(args)) {
        for (var key in args) {
            var value = args[key];
            parts.push(key + ": " + (typeof value === "string" ? value : JSON.stringify(value)));
        }
    }
    return compact(parts.length > 0 ? name + " " + parts.join(", ") : name, limit);
}

var SHELL_TOOLS = { bash: true, shell: true, exec_command: true, local_shell: true, run_terminal_cmd: true };
var READ_TOOLS = { read: true, view: true, read_file: true };
var WRITE_TOOLS = { write: true, write_file: true, create: true };
var EDIT_TOOLS = { edit: true, multiedit: true, str_replace: true, apply_patch: true, patch: true };

/**
 * The file a call wrote, named the way the tool named it. Writers only — a
 * read changed nothing worth opening. Native file tools resolve relative paths
 * against the cwd captured on that activity.
 */
function fileTarget(activity) {
    var name = toolName(activity);
    if (WRITE_TOOLS[name]) return pathArgument(activity);
    if (EDIT_TOOLS[name]) return editedPath(activity);
    return "";
}

function fileCwd(activity) {
    return typeof activity.cwd === "string" ? activity.cwd.trim() : "";
}

/**
 * A call as pi shows it: what is being done, never what came back. `$ git
 * status`, `read ~/notes/plan.md:10-40`, `edit src/app.ts`, `grep /retry/ in
 * src (*.ts)`, `find *.md in docs`, and any other tool as its name and
 * arguments. Ghost's own desktop tools carry no command or path to show, so
 * they keep a plain phrase, running or done.
 */
function call(activity, completed, limit) {
    var name = toolName(activity);
    var cwd = fileCwd(activity);
    var path = function (value, fallbackPath) {
        var shown = shortPath(value, cwd);
        return shown !== "" ? shown : fallbackPath;
    };
    if (SHELL_TOOLS[name]) {
        var command = shellCommand(activity);
        return "$ " + (command !== "" ? compact(command, limit) : "…");
    }
    if (READ_TOOLS[name]) return compact("read " + path(pathArgument(activity), "…") + lineRange(activity), limit);
    if (WRITE_TOOLS[name]) return compact("write " + path(pathArgument(activity), "…"), limit);
    if (EDIT_TOOLS[name]) return compact("edit " + path(editedPath(activity), "…"), limit);
    var args = activity.arguments || ({});
    switch (name) {
    case "ls":
    case "list":
    case "list_dir":
        return compact("ls " + path(argument(activity, "path"), "."), limit);
    case "grep":
    case "search": {
        var glob = argument(activity, "glob") || argument(activity, "include");
        return compact("grep /" + argument(activity, "pattern") + "/ in " + path(argument(activity, "path"), ".")
            + (glob !== "" ? " (" + glob + ")" : ""), limit);
    }
    case "find":
    case "glob":
        return compact("find " + argument(activity, "pattern") + " in " + path(argument(activity, "path"), "."), limit);
    case "desktop_look":
        if (args.image === true || args.region || args.monitor)
            return completed ? "Checked what’s on screen" : "Checking what’s on screen";
        if (args.ui === true)
            return completed ? "Looked through a window" : "Looking through a window";
        return completed ? "Checked the desktop" : "Checking the desktop";
    // Historical transcripts still carry this retired tool name.
    case "ghost_browser": {
        var action = argument(activity, "action");
        var url = argument(activity, "url");
        var query = argument(activity, "query");
        if (action === "open" && url !== "")
            return (completed ? "Opened " : "Opening ") + url;
        if (action === "find" && query !== "")
            return (completed ? "Looked for " : "Looking for ") + quoted(query, limit) + " on the page";
        if (action === "read")
            return completed ? "Read the current page" : "Reading the current page";
        if (action === "type")
            return completed ? "Filled in the page" : "Filling in the page";
        if (action === "click")
            return completed ? "Followed something on the page" : "Following something on the page";
        return completed ? "Checked the current page" : "Checking the current page";
    }
    case "desktop_act": {
        var steps = args.steps;
        var only = Array.isArray(steps) && steps.length === 1 ? String((steps[0] && steps[0].do) || "") : "";
        if (only === "type")
            return completed ? "Typed on the desktop" : "Typing on the desktop";
        return completed ? "Worked on the desktop" : "Working on the desktop";
    }
    default:
        return genericCall(String(activity.name || "tool"), activity, Math.min(limit, 100));
    }
}

/**
 * One line for a call, pi's way: the call itself, running or done. What came
 * back is `output`, shown only where someone asks for it or the call failed;
 * a result is the work's material ("(no output)", a file's bytes), not an
 * account of what the ghost is doing. `expanded` is for a surface that wraps
 * (an open card, the activity line) and keeps a command or path whole.
 */
function text(activity, completed, expanded) {
    return call(activity, completed, expanded ? 1200 : 100);
}

/** What the call returned, one line: the error of a failed call, the output of any. */
function output(activity) {
    return compact(activity.summary || "", 600);
}

function view(activity, completed, expanded) {
    return {
        trace: text(activity, completed, expanded),
        diagnosticOutput: output(activity),
        fileTarget: fileTarget(activity),
        fileCwd: fileCwd(activity)
    };
}
