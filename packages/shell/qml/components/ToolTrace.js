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

function isAsk(activity) {
    return String(activity.name || "") === "ask";
}

/**
 * How the question ended, from the daemon's `askSettled`. Anything the runtime
 * did not say — an older transcript, a live ask still standing open — reads as
 * unknown, and every caller here treats unknown as "say nothing" rather than
 * guessing an outcome. That guess is exactly what used to report an answer for
 * a question the user closed the app on.
 */
function askSettlement(activity) {
    switch (String(activity.askSettled || "")) {
    case "submitted":
    case "cancelled":
    case "timedOut":
    case "chat":
        return String(activity.askSettled);
    default:
        return "";
    }
}

/**
 * The questions this ask put to the user, normalised. Gated on the tool name
 * rather than on the shape of the arguments: some other tool is free to take a
 * `questions` array without meaning OMP's ask dialog by it.
 */
function askQuestions(activity) {
    const args = activity.arguments;
    if (!isAsk(activity) || !args || typeof args !== "object") return [];
    if (!Array.isArray(args.questions)) return [];
    const out = [];
    for (const raw of args.questions) {
        if (!raw || typeof raw !== "object") continue;
        const question = typeof raw.question === "string" ? raw.question.trim() : "";
        if (question === "") continue;
        const recommended = typeof raw.recommended === "number" ? raw.recommended : -1;
        const options = [];
        if (Array.isArray(raw.options)) {
            raw.options.forEach(function (option, index) {
                const label = typeof option === "string"
                    ? option
                    : (option && typeof option.label === "string" ? option.label : "");
                if (label.trim() === "") return;
                options.push({ label: label.trim(), recommended: index === recommended });
            });
        }
        out.push({
            header: typeof raw.header === "string" ? raw.header.trim() : "",
            question: question,
            options: options
        });
    }
    return out;
}

/**
 * The question itself, for the line under the trace. This stays out of the
 * expand: a settled card that says only "never got an answer" is a card about
 * nothing, and the question is the one thing a reader scrolling back has lost.
 * Only the first one — the rest are counted here and named when expanded,
 * because the line has room for exactly one.
 */
function askPrompt(activity) {
    const questions = askQuestions(activity);
    if (questions.length === 0) return "";
    const first = questions[0];
    const head = first.header !== "" ? first.header + " · " : "";
    const others = questions.length - 1;
    const tail = others === 0
        ? ""
        : "  +" + others + (others === 1 ? " more question" : " more questions");
    return head + compact(first.question, 1200) + tail;
}

/**
 * What expanding an ask card adds: the options it offered, and the questions
 * the collapsed line could only count. Each line carries its own label so the
 * block sits among "Tool ·" and "Input ·" instead of floating unlabelled.
 */
function askDetail(activity) {
    const lines = [];
    askQuestions(activity).forEach(function (question, index) {
        if (index > 0) lines.push("Also asked · " + compact(question.question, 300));
        const options = question.options.map(function (option) {
            return option.recommended ? option.label + " (recommended)" : option.label;
        });
        if (options.length > 0) lines.push("Options · " + options.join(" · "));
    });
    return lines.join("\n");
}

/**
 * True when this card is a question no answer ever reached — still standing
 * open, or settled without one. A question the ghost is still holding is
 * nearer to a failed call than to a file read, so the card can drop the amber
 * every ordinary tool wears. Unknown settlement on a finished call is not
 * counted: not knowing is not the same as knowing it went unanswered.
 */
function askAwaiting(activity, completed) {
    if (!isAsk(activity)) return false;
    const settled = askSettlement(activity);
    if (settled === "cancelled" || settled === "timedOut") return true;
    return settled === "" && !completed;
}

/**
 * The card's action. "Re-answer" is a lie on a question that was never
 * answered once, so anything but a submitted ask offers a first answer.
 */
function askAction(activity) {
    return askSettlement(activity) === "submitted" ? "Re-answer" : "Answer it";
}

/**
 * The file a call wrote, named the way the tool named it: absolute, or relative
 * to the session cwd, which OMP sets to the ghost home. Writers only — a read
 * changed nothing worth opening. Resolving this to an absolute path (and
 * deciding whether anything can render it) belongs to the caller.
 */
function fileTarget(activity) {
    switch (String(activity.name || "")) {
    case "write":
    case "edit":
        // OMP's native file tools take `path`; some providers emit `file_path`.
        return argument(activity, "path") || argument(activity, "file_path");
    // Historical transcripts keep the old tool name, but the home migration
    // moved their targets into docs/ too.
    case "ghost_notes_write": {
        // A doc path is relative to the docs directory, not to the home.
        const doc = argument(activity, "path");
        return doc === "" ? "" : "docs/" + doc;
    }
    case "ghost_character":
        // Only the write action changes the file; the path is fixed by the
        // ghost-home layout rather than carried in the arguments.
        return argument(activity, "action") === "write" ? "character.md" : "";
    default:
        return "";
    }
}

// A trace describes the purpose of the work, never the mechanism used to do
// it. These fallbacks also keep restored transcripts useful: persisted tool
// calls retain their arguments, while live intent/result summaries do not.
function fallback(activity, completed, failed) {
    const name = String(activity.name || "");
    const query = argument(activity, "query");
    const path = argument(activity, "path");
    const written = fileTarget(activity);
    const memoryName = argument(activity, "name");
    const action = argument(activity, "action");
    const url = argument(activity, "url");

    switch (name) {
    case "ask":
        switch (askSettlement(activity)) {
        case "submitted":
            return "Received your answer";
        case "cancelled":
            return "Never got an answer";
        case "timedOut":
            return "Stopped waiting for an answer";
        // OMP's "Chat about this": the question was set aside for the
        // conversation rather than answered in the card.
        case "chat":
            return "Talked it through instead";
        default:
            // An ask that errored out was closed, aborted, or abandoned — the
            // one thing it certainly was not is answered.
            if (failed) return "Never got an answer";
            // Nothing here knows the outcome, so the trace reports only what
            // is certain: that the question was put.
            return completed ? "Asked you a question" : "Waiting for your answer";
        }
    case "ghost_notes_list":
        return completed ? "Looked through your docs" : "Looking through your docs";
    case "ghost_notes_read":
        return path !== ""
            ? (completed ? "Read " : "Reading ") + path
            : (completed ? "Read a document" : "Reading a document");
    case "ghost_notes_grep":
        return query !== ""
            ? (completed ? "Looked for " : "Looking for ")
                + quoted(query) + " in your docs"
            : (completed ? "Searched your docs" : "Searching your docs");
    case "ghost_notes_write":
        return path !== ""
            ? (completed ? "Updated " : "Updating ") + path
            : (completed ? "Saved a document" : "Saving a document");
    // OMP's own file tools. A session writes docs and memory through
    // these rather than the ghost_* ones, so without them a restored transcript
    // shows nothing where the ghost changed a file.
    case "write":
        return written !== ""
            ? (completed ? "Wrote " : "Writing ") + written
            : (completed ? "Wrote a file" : "Writing a file");
    case "edit":
        return written !== ""
            ? (completed ? "Edited " : "Editing ") + written
            : (completed ? "Edited a file" : "Editing a file");
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
    // The ghost's own character.md. It is the only file the ghost is the
    // subject of rather than the reader of, so the trace says "its own".
    case "ghost_character":
        if (action === "write")
            return completed ? "Wrote its character" : "Writing its character";
        return completed ? "Read its own character" : "Reading its own character";
    // `look_at_image` was ghost's own tool before OMP's native `inspect_image`
    // took the job. Historical transcripts still replay the old name.
    case "inspect_image":
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
    const base = summary || intent || fallback(activity, completed, failed);
    // An ask that failed is not a tool that broke — it is a question that went
    // unanswered, and its own trace already says so. "Couldn't complete" in
    // front of that would report a malfunction where there was only a silence.
    if (failed && summary === "" && base !== "" && !isAsk(activity))
        return "Couldn’t complete: " + base;
    return base;
}

function input(activity) {
    const args = activity.arguments;
    if (!args || typeof args !== "object") return "";
    if (Array.isArray(args.questions)) {
        // An ask card renders the questions themselves, so a count beside them
        // is noise — and the fall-through below would dump the raw array.
        if (isAsk(activity)) return "";
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
