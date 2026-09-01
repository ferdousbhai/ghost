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

/**
 * The file a call names, whichever harness asked for it. pi's native tools take
 * `path`, Claude Code's take `file_path`, and its notebook editor takes
 * `notebook_path`. Same file, same sentence.
 */
function pathArgument(activity) {
    return argument(activity, "path")
        || argument(activity, "file_path")
        || argument(activity, "notebook_path");
}

/**
 * One name for one job.
 *
 * The two harnesses do the same work under different spellings — pi's `read`
 * is Claude Code's `Read`, its `find` is `Glob` — and the wire deliberately
 * carries whichever name actually ran, because a transcript is a record of
 * what happened and Claude's `Read` takes a `file_path` that pi's `read` would
 * not recognise. Presentation is where the two vocabularies meet, and this is
 * the one place in it that knows they are two: everything below reads the
 * canonical name, so a tool Claude renames is one line here rather than a
 * search through five switch statements.
 */
var CANONICAL = {
    Read: "read",
    Write: "write",
    Edit: "edit",
    NotebookEdit: "edit",
    Bash: "bash",
    Grep: "grep",
    Glob: "find",
    // Ghost's own pre-OMP name for the work `inspect_image` does now; historical
    // transcripts still replay it.
    look_at_image: "inspect_image",
    // pi's memory tools under the names older sessions wrote them with.
    list_memory: "ghost_memory_list"
};

function canonicalName(activity) {
    const name = String(activity.name || "");
    return CANONICAL[name] || name;
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
    },
    WebFetch: {
        past: "Read", present: "Reading", key: "url",
        alonePast: "Read a page", alonePresent: "Reading a page"
    },
    WebSearch: {
        past: "Searched the web for", present: "Searching the web for",
        key: "query", quote: true,
        alonePast: "Searched the web", alonePresent: "Searching the web"
    },
    Task: {
        past: "Delegated", present: "Delegating", key: "description",
        alonePast: "Delegated a task", alonePresent: "Delegating a task"
    },
    ghost_notes_read: {
        past: "Read", present: "Reading", key: "path",
        alonePast: "Read a document", alonePresent: "Reading a document"
    },
    ghost_notes_write: {
        past: "Updated", present: "Updating", key: "path",
        alonePast: "Saved a document", alonePresent: "Saving a document"
    },
    ghost_notes_grep: {
        past: "Looked for", present: "Looking for", key: "query", quote: true,
        suffix: " in your docs",
        alonePast: "Searched your docs", alonePresent: "Searching your docs"
    },
    ghost_memory_read: {
        past: "Recalled", present: "Recalling", key: "name",
        alonePast: "Recalled a memory", alonePresent: "Recalling a memory"
    },
    read_memory: {
        past: "Looked for", present: "Looking for", key: "query", quote: true,
        suffix: " in memory",
        alonePast: "Recalled a memory", alonePresent: "Recalling a memory"
    }
};

function verbTrace(verb, activity, completed) {
    const raw = verb.of ? verb.of(activity) : argument(activity, verb.key);
    if (raw === "") return completed ? verb.alonePast : verb.alonePresent;
    return (completed ? verb.past : verb.present) + " "
        + (verb.quote ? quoted(raw) : compact(raw, 80)) + (verb.suffix || "");
}


function isAsk(activity) {
    return String(activity.name || "") === "ask";
}

/**
 * A list, however QML handed it over.
 *
 * Every activity this file reads has crossed a ListModel role and a Repeater's
 * `modelData` on its way here, and both hand a JS array back as a variant list:
 * it indexes and measures like an array and fails `Array.isArray` outright. So
 * the test has to be whether a value behaves like a list, not whether it was
 * born as one — asking the wrong question here is silent, and a restored ask
 * card answers it by rendering no question and no options at all.
 */
function listOf(value) {
    if (Array.isArray(value)) return value;
    if (!value || typeof value !== "object" || typeof value.length !== "number") return [];
    const out = [];
    for (let i = 0; i < value.length; i++) out.push(value[i]);
    return out;
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
 * `questions` array without meaning Ghost's ask dialog by it.
 */
function askQuestions(activity) {
    const args = activity.arguments;
    if (!isAsk(activity) || !args || typeof args !== "object") return [];
    const out = [];
    for (const raw of listOf(args.questions)) {
        if (!raw || typeof raw !== "object") continue;
        const question = typeof raw.question === "string" ? raw.question.trim() : "";
        if (question === "") continue;
        const recommended = typeof raw.recommended === "number" ? raw.recommended : -1;
        const options = [];
        listOf(raw.options).forEach(function (option, index) {
            const label = typeof option === "string"
                ? option
                : (option && typeof option.label === "string" ? option.label : "");
            if (label.trim() === "") return;
            options.push({ label: label.trim(), recommended: index === recommended });
        });
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
function askPromptFromQuestions(questions) {
    if (questions.length === 0) return "";
    const first = questions[0];
    const head = first.header !== "" ? first.header + " · " : "";
    const others = questions.length - 1;
    const tail = others === 0
        ? ""
        : "  +" + others + (others === 1 ? " more question" : " more questions");
    return head + compact(first.question, 1200) + tail;
}

function askPrompt(activity) {
    activity = fields(activity);
    return askPromptFromQuestions(askQuestions(activity));
}

/**
 * What expanding an ask card adds: the options it offered, and the questions
 * the collapsed line could only count. Each line carries its own label so the
 * block sits among "Tool ·" and "Input ·" instead of floating unlabelled.
 */
function askDetailFromQuestions(questions) {
    const lines = [];
    questions.forEach(function (question, index) {
        if (index > 0) lines.push("Also asked · " + compact(question.question, 300));
        const options = question.options.map(function (option) {
            return option.recommended ? option.label + " (recommended)" : option.label;
        });
        if (options.length > 0) lines.push("Options · " + options.join(" · "));
    });
    return lines.join("\n");
}

function askDetail(activity) {
    activity = fields(activity);
    return askDetailFromQuestions(askQuestions(activity));
}

/**
 * The option the clock submitted on the owner's behalf, or "".
 *
 * The daemon answers an expired ask with the question's recommended option and
 * persists nothing else about it, so naming the choice means reading it back
 * out of the arguments the model sent. A question that recommended nothing
 * timed out with nothing chosen, and the card has to say that instead.
 */
function askAutoAnswerFromQuestions(questions) {
    if (questions.length === 0) return "";
    const chosen = questions[0].options.filter(function (option) {
        return option.recommended;
    });
    return chosen.length > 0 ? chosen[0].label : "";
}

function askAutoAnswer(activity) {
    activity = fields(activity);
    return askAutoAnswerFromQuestions(askQuestions(activity));
}

function askPresentation(activity, completed) {
    const questions = askQuestions(activity);
    const settlement = askSettlement(activity);
    const autoAnswer = askAutoAnswerFromQuestions(questions);
    let action = "Answer it";
    if (settlement === "submitted") action = "Re-answer";
    else if (settlement === "timedOut" && autoAnswer !== "") action = "Change it";
    return {
        settlement: settlement,
        autoAnswer: autoAnswer,
        prompt: askPromptFromQuestions(questions),
        detail: askDetailFromQuestions(questions),
        awaiting: isAsk(activity) && (settlement === "cancelled"
            || settlement === "timedOut" || (settlement === "" && !completed)),
        action: action
    };
}

/**
 * True when this card is a question the OWNER never answered — still standing
 * open, or settled without them. A timed-out ask counts even though the clock
 * did submit something: an answer chosen in the owner's absence is exactly the
 * one worth a second look. Unknown settlement on a finished call is not
 * counted: not knowing is not the same as knowing it went unanswered.
 */
function askAwaiting(activity, completed) {
    activity = fields(activity);
    return askPresentation(activity, completed).awaiting;
}

/**
 * The card's action. "Re-answer" is a lie on a question that was never
 * answered once, so anything but a submitted ask offers a first answer — and a
 * question the clock answered offers a correction, because there is already a
 * decision standing that the owner may not agree with.
 */
function askAction(activity) {
    activity = fields(activity);
    return askPresentation(activity, false).action;
}

/**
 * The file a call wrote, named the way the tool named it. Writers only — a
 * read changed nothing worth opening. Native file tools resolve relative paths
 * against the cwd captured on that activity; legacy Ghost-owned writers stay
 * relative to the ghost home.
 */
function fileTarget(activity) {
    activity = fields(activity);
    switch (canonicalName(activity)) {
    case "write":
    case "edit":
        return pathArgument(activity);
    // Historical transcripts keep the old tool name and target retired
    // per-ghost files. They are never shared Documents paths.
    case "ghost_notes_write": {
        // A doc path is relative to the docs directory, not to the home.
        const doc = argument(activity, "path");
        return doc === "" ? "" : "docs/" + doc;
    }
    default:
        return "";
    }
}

/** Which explicit path base the caller must use for {@link fileTarget}. */
function fileBase(activity) {
    activity = fields(activity);
    switch (canonicalName(activity)) {
    case "write":
    case "edit":
        return "cwd";
    case "ghost_notes_write":
        return "ghost";
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
function fallback(activity, completed, failed, preparedAsk, preparedFileTarget) {
    const name = canonicalName(activity);
    const verb = VERBS[name];
    if (verb) return verbTrace(verb, activity, completed);

    switch (name) {
    case "ask": {
        const ask = preparedAsk || askPresentation(activity, completed);
        switch (ask.settlement) {
        case "submitted":
            return "Received your answer";
        case "cancelled":
            return "Never got an answer";
        // A deadline the owner missed is not the same news as a question
        // nobody ever answered: something was decided for them, and the card
        // is the only place they will ever find out what.
        case "timedOut": {
            const taken = ask.autoAnswer;
            return taken !== ""
                ? "Time ran out — answered " + quoted(taken) + " for you"
                : "Time ran out — nothing was answered";
        }
        // Ghost's "Chat about this": the question was set aside for the
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
    }
    case "ghost_notes_list":
        return completed ? "Looked through your docs" : "Looking through your docs";
    // The writers are not in the verb table: their argument is the same one the
    // workbench chip resolves, and the caller has usually already paid for it.
    case "write": {
        const written = preparedFileTarget === undefined
            ? fileTarget(activity) : preparedFileTarget;
        return written !== ""
            ? (completed ? "Wrote " : "Writing ") + written
            : (completed ? "Wrote a file" : "Writing a file");
    }
    case "edit": {
        const written = preparedFileTarget === undefined
            ? fileTarget(activity) : preparedFileTarget;
        return written !== ""
            ? (completed ? "Edited " : "Editing ") + written
            : (completed ? "Edited a file" : "Editing a file");
    }
    case "BashOutput":
        return completed
            ? "Checked on a running command"
            : "Checking on a running command";
    case "KillShell":
        return completed ? "Stopped a running command" : "Stopping a running command";
    case "TodoWrite":
        return completed ? "Updated its plan" : "Updating its plan";
    case "ghost_memory_list":
        return completed
            ? "Looked through remembered details"
            : "Looking through remembered details";
    case "write_memory":
        return completed ? "Saved something to memory" : "Saving something to memory";
    case "inspect_image":
        return completed ? "Looked closely at the image" : "Looking closely at the image";
    case "ghost_screen":
        return completed ? "Checked what’s on screen" : "Checking what’s on screen";
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
    case "ghost_desktop": {
        const action = argument(activity, "action");
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
    }
    default:
        return "";
    }
}

/**
 * Tools whose result is the work itself rather than an account of it: a file's
 * bytes, a page's text, a directory's entries. Both runtimes put that result on
 * the wire as `summary`, and 180 characters of it says less than "Read
 * src/foo.ts" does. A failure is the exception — its text is the only thing
 * that explains what went wrong.
 */
function resultIsRawContent(activity) {
    switch (canonicalName(activity)) {
    case "read":
    case "ls":
    case "WebFetch":
        return true;
    default:
        return false;
    }
}

function text(activity, completed, failed, expanded, preparedAsk, preparedFileTarget) {
    activity = fields(activity);
    const limit = expanded ? 1200 : 180;
    const summary = !failed && resultIsRawContent(activity)
        ? "" : compact(activity.summary || "", limit);
    const intent = compact(activity.intent || "", limit);
    const base = summary || intent
        || fallback(activity, completed, failed, preparedAsk, preparedFileTarget);
    // An ask that failed is not a tool that broke — it is a question that went
    // unanswered, and its own trace already says so. "Couldn't complete" in
    // front of that would report a malfunction where there was only a silence.
    if (failed && summary === "" && base !== "" && !isAsk(activity))
        return "Couldn’t complete: " + base;
    return base;
}

function input(activity) {
    activity = fields(activity);
    const args = activity.arguments;
    if (!args || typeof args !== "object") return "";
    const questions = listOf(args.questions);
    if (questions.length > 0) {
        // An ask card renders the questions themselves, so a count beside them
        // is noise — and the fall-through below would dump the raw array.
        if (isAsk(activity)) return "";
        return questions.length + (questions.length === 1 ? " question" : " questions");
    }
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
    const ask = askPresentation(activity, completed);
    const diagnosticInput = input(activity);
    const target = fileTarget(activity);
    return {
        trace: text(activity, completed, failed, expanded, ask, target),
        diagnosticInput: diagnosticInput,
        hasDiagnostics: hasDiagnostics(activity, diagnosticInput),
        askAwaiting: ask.awaiting,
        askPrompt: ask.prompt,
        askDetail: ask.detail,
        askAction: ask.action,
        fileTarget: target,
        fileBase: fileBase(activity),
        fileCwd: fileCwd(activity)
    };
}
