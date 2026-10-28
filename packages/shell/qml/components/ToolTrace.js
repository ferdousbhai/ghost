.pragma library

/**
 * The activity a card is asking about, or a stand-in for one.
 *
 * A Repeater re-evaluates a delegate's bindings while it is tearing it down,
 * with `modelData` already gone, so every public function here can be called
 * with nothing at all — and each of them reaches straight into the object.
 * Normalising once at the entry points beats a guard on every field read, and
 * beats what it replaced: a card spending its last frame throwing TypeErrors.
 */
function fields(activity) {
    return activity || ({});
}

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

/**
 * A call as pi shows it: what is being done, never what came back. `$ git
 * status`, `read ~/notes/plan.md:10-40`, `edit src/app.ts`, `grep /retry/ in
 * src (*.ts)`, `find *.md in docs`, and any other tool as its name and
 * arguments. Ghost's own desktop tools carry no command or path to show, so
 * they keep their plain phrase.
 */
function piCall(activity, limit) {
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
    switch (name) {
    case "read":
    case "view":
    case "read_file":
        return compact("read " + path(pathArgument(activity), "…") + lineRange(activity), limit);
    case "write":
    case "write_file":
    case "create":
        return compact("write " + path(pathArgument(activity), "…"), limit);
    case "edit":
    case "multiedit":
    case "str_replace":
    case "apply_patch":
    case "patch":
        return compact("edit " + path(editedPath(activity), "…"), limit);
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
    default:
        return "";
    }
}

/**
 * The file a call wrote, named the way the tool named it. Writers only — a
 * read changed nothing worth opening. Native file tools resolve relative paths
 * against the cwd captured on that activity.
 */
function fileTarget(activity) {
    activity = fields(activity);
    switch (toolName(activity)) {
    case "write":
    case "edit":
        return pathArgument(activity);
    default:
        return "";
    }
}

function fileCwd(activity) {
    activity = fields(activity);
    return typeof activity.cwd === "string" ? activity.cwd.trim() : "";
}

// A trace describes the purpose of the work, never the mechanism used to do
// it. These fallbacks also keep restored transcripts useful: persisted tool
// calls retain their arguments, while live result summaries do not.
function fallback(activity, completed, limit) {
    const name = toolName(activity);
    const call = piCall(activity, limit);
    if (call !== "") return call;

    switch (name) {
    case "desktop_look": {
        const args = activity.arguments || ({});
        if (args.image === true || args.region || args.monitor)
            return completed ? "Checked what’s on screen" : "Checking what’s on screen";
        if (args.ui === true)
            return completed ? "Looked through a window" : "Looking through a window";
        return completed ? "Checked the desktop" : "Checking the desktop";
    }
    // Historical transcripts still carry this retired tool name.
    case "ghost_browser": {
        const action = argument(activity, "action");
        const url = argument(activity, "url");
        const query = argument(activity, "query");
        if (action === "open" && url !== "")
            return (completed ? "Opened " : "Opening ") + url;
        if (action === "find" && query !== "")
            return (completed ? "Looked for " : "Looking for ")
                + quoted(query, limit) + " on the page";
        if (action === "read")
            return completed ? "Read the current page" : "Reading the current page";
        if (action === "type")
            return completed ? "Filled in the page" : "Filling in the page";
        if (action === "click")
            return completed
                ? "Followed something on the page"
                : "Following something on the page";
        return completed ? "Checked the current page" : "Checking the current page";
    }
    case "desktop_act": {
        const steps = (activity.arguments || ({})).steps;
        const only = Array.isArray(steps) && steps.length === 1
            ? String((steps[0] && steps[0].do) || "") : "";
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
function text(activity, completed, failed, expanded) {
    activity = fields(activity);
    return fallback(activity, completed, expanded ? 1200 : 100);
}

/** What the call returned, one line: the error of a failed call, the output of any. */
function output(activity) {
    activity = fields(activity);
    return compact(activity.summary || "", 600);
}

function input(activity) {
    activity = fields(activity);
    const args = activity.arguments;
    if (!args || typeof args !== "object") return "";
    const keys = [
        "query", "path", "file_path", "notebook_path", "command", "pattern",
        "name", "url", "action", "description", "prompt", "source",
    ];
    for (const key of keys) {
        if (typeof args[key] === "string" && args[key].trim() !== "")
            return compact(args[key], 150);
    }
    const json = JSON.stringify(args);
    return json === "{}" ? "" : compact(json, 150);
}

function view(activity, completed, failed, expanded) {
    activity = fields(activity);
    const diagnosticInput = input(activity);
    return {
        trace: text(activity, completed, failed, expanded),
        diagnosticInput: diagnosticInput,
        diagnosticOutput: output(activity),
        fileTarget: fileTarget(activity),
        fileCwd: fileCwd(activity)
    };
}
