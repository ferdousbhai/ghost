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

function quoted(value) {
    return "“" + compact(value, 80) + "”";
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
 * The tools that are a verb and one argument. Every one of them reads the same
 * way — "Reading docs/design.md", "Ran pnpm test" — and writing them out was a
 * dozen near-identical blocks that had to be found and edited one at a time.
 * The sentence with no argument is spelled out rather than derived: "Searching
 * for the files" is not what "Searching the files" turns into.
 */
var VERBS = {
    read: {
        past: "Read", present: "Reading", of: pathArgument,
        alonePast: "Read a file", alonePresent: "Reading a file"
    },
    write: {
        past: "Wrote", present: "Writing", of: pathArgument,
        alonePast: "Wrote a file", alonePresent: "Writing a file"
    },
    edit: {
        past: "Edited", present: "Editing", of: pathArgument,
        alonePast: "Edited a file", alonePresent: "Editing a file"
    },
    ls: {
        past: "Listed", present: "Listing", key: "path",
        alonePast: "Listed a directory", alonePresent: "Listing a directory"
    },
    bash: {
        past: "Ran", present: "Running", key: "command",
        alonePast: "Ran a command", alonePresent: "Running a command"
    },
    grep: {
        past: "Searched for", present: "Searching for", key: "pattern", quote: true,
        alonePast: "Searched the files", alonePresent: "Searching the files"
    },
    find: {
        past: "Looked for files matching", present: "Looking for files matching",
        key: "pattern", quote: true,
        alonePast: "Looked for files", alonePresent: "Looking for files"
    }
};

function verbTrace(verb, activity, completed) {
    const raw = verb.of ? verb.of(activity) : argument(activity, verb.key);
    if (raw === "") return completed ? verb.alonePast : verb.alonePresent;
    return (completed ? verb.past : verb.present) + " "
        + (verb.quote ? quoted(raw) : compact(raw, 80)) + (verb.suffix || "");
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
// calls retain their arguments, while live intent/result summaries do not.
function fallback(activity, completed) {
    const name = toolName(activity);
    const verb = VERBS[name];
    if (verb) return verbTrace(verb, activity, completed);

    switch (name) {
    case "desktop_look": {
        const args = activity.arguments || ({});
        if (args.image === true || args.region || args.monitor)
            return completed ? "Checked what’s on screen" : "Checking what’s on screen";
        if (args.ui === true)
            return completed ? "Looked through a window" : "Looking through a window";
        return completed ? "Checked the desktop" : "Checking the desktop";
    }
    case "ghost_browser": {
        const action = argument(activity, "action");
        const url = argument(activity, "url");
        const query = argument(activity, "query");
        if (action === "open" && url !== "")
            return (completed ? "Opened " : "Opening ") + url;
        if (action === "find" && query !== "")
            return (completed ? "Looked for " : "Looking for ")
                + quoted(query) + " on the page";
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
        if (only === "workspace")
            return completed ? "Switched workspaces" : "Switching workspaces";
        if (only === "focus")
            return completed ? "Focused a window" : "Focusing a window";
        if (only === "type")
            return completed ? "Typed on the desktop" : "Typing on the desktop";
        if (only === "notify")
            return completed ? "Sent a notification" : "Sending a notification";
        if (only === "launch")
            return completed ? "Opened an app" : "Opening an app";
        return completed ? "Worked on the desktop" : "Working on the desktop";
    }
    default:
        return "";
    }
}

/**
 * Tools whose result is the work itself rather than an account of it: a file's
 * bytes, a page's text, a directory's entries. The runtime puts that result on
 * the wire as `summary`, and 180 characters of it says less than "Read
 * src/foo.ts" does. A failure is the exception — its text is the only thing
 * that explains what went wrong.
 */
function resultIsRawContent(activity) {
    switch (toolName(activity)) {
    case "read":
    case "ls":
        return true;
    default:
        return false;
    }
}

function text(activity, completed, failed, expanded) {
    activity = fields(activity);
    const limit = expanded ? 1200 : 180;
    const summary = !failed && resultIsRawContent(activity)
        ? "" : compact(activity.summary || "", limit);
    const intent = compact(activity.intent || "", limit);
    const base = summary || intent || fallback(activity, completed);
    if (failed && summary === "" && base !== "")
        return "Couldn’t complete: " + base;
    return base;
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

function hasDiagnostics(activity, preparedInput) {
    activity = fields(activity);
    return String(activity.name || "") !== ""
        || (preparedInput === undefined ? input(activity) : preparedInput) !== ""
        || Boolean(activity.intent && activity.summary);
}

function view(activity, completed, failed, expanded) {
    activity = fields(activity);
    const diagnosticInput = input(activity);
    return {
        trace: text(activity, completed, failed, expanded),
        diagnosticInput: diagnosticInput,
        hasDiagnostics: hasDiagnostics(activity, diagnosticInput),
        fileTarget: fileTarget(activity),
        fileCwd: fileCwd(activity)
    };
}
