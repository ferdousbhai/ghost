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

function quoted(value) {
    return "“" + compact(value, 80) + "”";
}

// A trace describes the purpose of the work, never the mechanism used to do
// it. These fallbacks also keep restored transcripts useful: persisted tool
// calls retain their arguments, while live intent/result summaries do not.
function fallback(activity, completed) {
    const name = String(activity.name || "");
    const query = argument(activity, "query");
    const path = argument(activity, "path");
    const memoryName = argument(activity, "name");
    const action = argument(activity, "action");
    const url = argument(activity, "url");

    switch (name) {
    case "ask":
        return completed ? "Received your answer" : "Waiting for your answer";
    case "ghost_notes_list":
        return completed ? "Looked through your notes" : "Looking through your notes";
    case "ghost_notes_read":
        return path !== ""
            ? (completed ? "Read " : "Reading ") + path
            : (completed ? "Read a note" : "Reading a note");
    case "ghost_notes_grep":
        return query !== ""
            ? (completed ? "Looked for " : "Looking for ")
                + quoted(query) + " in your notes"
            : (completed ? "Searched your notes" : "Searching your notes");
    case "ghost_notes_write":
        return path !== ""
            ? (completed ? "Updated " : "Updating ") + path
            : (completed ? "Saved a note" : "Saving a note");
    case "ghost_memory_list":
    case "list_memory":
        return completed
            ? "Looked through remembered details"
            : "Looking through remembered details";
    case "ghost_memory_read":
        return memoryName !== ""
            ? (completed ? "Recalled " : "Recalling ") + memoryName
            : (completed ? "Recalled a memory" : "Recalling a memory");
    case "read_memory":
        return query !== ""
            ? (completed ? "Looked for " : "Looking for ")
                + quoted(query) + " in memory"
            : (completed ? "Recalled a memory" : "Recalling a memory");
    case "ghost_memory_write":
    case "write_memory":
        return completed ? "Saved something to memory" : "Saving something to memory";
    case "look_at_image":
        return completed ? "Looked closely at the image" : "Looking closely at the image";
    case "ghost_screen":
        return completed ? "Checked what’s on screen" : "Checking what’s on screen";
    case "ghost_browser":
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
    case "ghost_desktop":
        if (action === "workspace")
            return completed ? "Switched workspaces" : "Switching workspaces";
        if (action === "focus")
            return completed ? "Focused a window" : "Focusing a window";
        if (action === "type")
            return completed ? "Typed on the desktop" : "Typing on the desktop";
        if (action === "notify")
            return completed ? "Sent a notification" : "Sending a notification";
        if (action === "ax_query")
            return completed
                ? "Looked through the current window"
                : "Looking through the current window";
        return completed ? "Worked on the desktop" : "Working on the desktop";
    default:
        return "";
    }
}

function text(activity, completed, failed, expanded) {
    const limit = expanded ? 1200 : 180;
    const summary = compact(activity.summary || "", limit);
    const intent = compact(activity.intent || "", limit);
    const base = summary || intent || fallback(activity, completed);
    if (failed && summary === "" && base !== "") return "Couldn’t complete: " + base;
    return base;
}

function input(activity) {
    const args = activity.arguments;
    if (!args || typeof args !== "object") return "";
    if (Array.isArray(args.questions)) {
        const count = args.questions.length;
        return count + (count === 1 ? " question" : " questions");
    }
    const keys = ["query", "path", "name", "url", "action", "prompt", "source"];
    for (const key of keys) {
        if (typeof args[key] === "string" && args[key].trim() !== "")
            return compact(args[key], 150);
    }
    const json = JSON.stringify(args);
    return json === "{}" ? "" : compact(json, 150);
}

function hasDiagnostics(activity) {
    return String(activity.name || "") !== ""
        || input(activity) !== ""
        || Boolean(activity.intent && activity.summary);
}
