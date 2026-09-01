.pragma library

// Strict validation and presentation for the bounded delegated-task API.
// Native protocol, process, identity, and error detail have no representation
// here, so malformed or expanded wire shapes fail closed before reaching QML.

const HARNESSES = ["claude-code", "codex", "pi"];
const AVAILABILITY = ["available", "unavailable"];
const AUTHENTICATION = ["authenticated", "logged_out", "unknown"];
const STATES = [
    "queued", "starting", "running", "cancelling",
    "completed", "failed", "cancelled", "interrupted"
];
const ACTIVE_STATES = ["queued", "starting", "running", "cancelling"];
const TERMINAL_STATES = ["completed", "failed", "cancelled", "interrupted"];
const STATE_PROGRESS = {
    queued: 0,
    starting: 1,
    running: 2,
    cancelling: 3,
    completed: 4,
    failed: 4,
    cancelled: 4,
    interrupted: 4
};
const TASK_KEYS = [
    "id", "harness", "agent", "cwd", "state", "createdAt", "updatedAt",
    "taskPreview", "taskTruncated", "resultPreview", "resultTruncated", "error"
];
const DETAIL_KEYS = TASK_KEYS.concat(["events", "eventsTruncated"]);
const TASK_ID = /^task-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODE = /^[a-z][a-z0-9_-]{0,63}$/u;

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
    if (!isObject(value)) return false;
    const keys = Object.keys(value).sort();
    const wanted = expected.slice().sort();
    if (keys.length !== wanted.length) return false;
    return keys.every(function (key, index) { return key === wanted[index]; });
}

function boundedText(value, maximum, allowEmpty) {
    return typeof value === "string" && (allowEmpty || value.length > 0)
        && value.length <= maximum && value.indexOf("\0") < 0;
}

function canonicalTimestamp(value) {
    if (typeof value !== "string") return false;
    try {
        return new Date(value).toISOString() === value;
    } catch (error) {
        return false;
    }
}

function canonicalPath(value) {
    if (!boundedText(value, 4096, false) || value.charAt(0) !== "/") return false;
    if (value === "/") return true;
    if (value.endsWith("/")) return false;
    return value.slice(1).split("/").every(function (part) {
        return part !== "" && part !== "." && part !== "..";
    });
}

function catalogue(value) {
    if (!exactKeys(value, ["harnesses"]) || !Array.isArray(value.harnesses)
            || value.harnesses.length !== HARNESSES.length)
        return null;
    const seen = ({});
    const rows = [];
    for (const raw of value.harnesses) {
        if (!exactKeys(raw, ["id", "availability", "authentication"])
                || HARNESSES.indexOf(raw.id) < 0 || seen[raw.id]
                || AVAILABILITY.indexOf(raw.availability) < 0
                || AUTHENTICATION.indexOf(raw.authentication) < 0)
            return null;
        seen[raw.id] = true;
        rows.push({
            id: raw.id,
            availability: raw.availability,
            authentication: raw.authentication
        });
    }
    return rows.sort(function (left, right) {
        return HARNESSES.indexOf(left.id) - HARNESSES.indexOf(right.id);
    });
}

function event(value) {
    if (!exactKeys(value, ["sequence", "at", "code", "message"])
            || !Number.isSafeInteger(value.sequence) || value.sequence < 1
            || !canonicalTimestamp(value.at) || typeof value.code !== "string"
            || !CODE.test(value.code) || !boundedText(value.message, 1024, true))
        return null;
    return {
        sequence: value.sequence,
        at: value.at,
        code: value.code,
        message: value.message
    };
}

function task(value, detailed) {
    if (!exactKeys(value, detailed ? DETAIL_KEYS : TASK_KEYS)
            || typeof value.id !== "string" || !TASK_ID.test(value.id)
            || HARNESSES.indexOf(value.harness) < 0
            || !(value.agent === null || boundedText(value.agent, 256, false))
            || !canonicalPath(value.cwd) || STATES.indexOf(value.state) < 0
            || !canonicalTimestamp(value.createdAt) || !canonicalTimestamp(value.updatedAt)
            || Date.parse(value.updatedAt) < Date.parse(value.createdAt)
            || !boundedText(value.taskPreview, 240, false)
            || typeof value.taskTruncated !== "boolean"
            // The daemon owns the preview cap; the shell only refuses what it
            // cannot render at all.
            || !(value.resultPreview === null
                || boundedText(value.resultPreview, Infinity, true))
            || typeof value.resultTruncated !== "boolean")
        return null;
    if (value.agent !== null && value.harness !== "claude-code") return null;
    if (!(value.error === null || (exactKeys(value.error, ["code", "message"])
            && typeof value.error.code === "string" && CODE.test(value.error.code)
            && boundedText(value.error.message, 512, true))))
        return null;
    let events = [];
    if (detailed) {
        if (!Array.isArray(value.events) || value.events.length > 10
                || typeof value.eventsTruncated !== "boolean") return null;
        for (const raw of value.events) {
            const parsed = event(raw);
            if (!parsed) return null;
            events.push(parsed);
        }
        for (let index = 1; index < events.length; index++) {
            if (events[index].sequence <= events[index - 1].sequence
                    || Date.parse(events[index].at) < Date.parse(events[index - 1].at))
                return null;
        }
        if (events.some(function (row) {
            return Date.parse(row.at) < Date.parse(value.createdAt)
                || Date.parse(row.at) > Date.parse(value.updatedAt);
        })) return null;
    }
    const hasResult = typeof value.resultPreview === "string";
    const hasError = value.error !== null;
    if (value.state === "completed" && (!hasResult || hasError)) return null;
    if ((value.state === "failed" || value.state === "interrupted")
            && (hasResult || !hasError)) return null;
    if (value.state !== "completed" && value.resultTruncated) return null;
    if (["queued", "starting", "running", "cancelling", "cancelled"].indexOf(value.state) >= 0
            && (hasResult || hasError)) return null;
    return {
        id: value.id,
        harness: value.harness,
        agent: value.agent,
        cwd: value.cwd,
        state: value.state,
        createdAt: value.createdAt,
        updatedAt: value.updatedAt,
        taskPreview: value.taskPreview,
        taskTruncated: value.taskTruncated,
        resultPreview: value.resultPreview,
        resultTruncated: value.resultTruncated,
        failed: value.error !== null,
        events,
        eventsTruncated: detailed && value.eventsTruncated === true
    };
}

function listing(value) {
    if (!exactKeys(value, ["tasks", "shown", "total"])
            || !Array.isArray(value.tasks) || value.tasks.length > 20
            || !Number.isSafeInteger(value.shown) || value.shown !== value.tasks.length
            || !Number.isSafeInteger(value.total) || value.total < value.shown)
        return null;
    const seen = ({});
    const tasks = [];
    for (const raw of value.tasks) {
        const parsed = task(raw, false);
        if (!parsed || seen[parsed.id]) return null;
        seen[parsed.id] = true;
        tasks.push(parsed);
    }
    return { tasks, shown: value.shown, total: value.total };
}

function label(id) {
    if (id === "claude-code") return "Claude Code";
    if (id === "codex") return "Codex";
    if (id === "pi") return "Pi";
    return "Worker";
}

function availabilityLabel(row) {
    if (!row || row.availability !== "available") return "Unavailable";
    if (row.authentication === "authenticated") return "Ready · signed in";
    if (row.authentication === "logged_out") return "Available · sign-in needed";
    return "Available";
}

function stateLabel(state) {
    if (state === "queued") return "Queued";
    if (state === "starting") return "Starting";
    if (state === "running") return "Running";
    if (state === "cancelling") return "Cancelling";
    if (state === "completed") return "Completed";
    if (state === "failed") return "Failed";
    if (state === "cancelled") return "Cancelled";
    if (state === "interrupted") return "Interrupted";
    return "Unknown";
}

function active(state) {
    return ACTIVE_STATES.indexOf(state) >= 0;
}

// Polls and mutation responses can cross in either order. Once a task is
// terminal, or a newer snapshot has landed, an older transport response may
// add no information and must not revive its controls.
function mergeTask(current, incoming) {
    if (!current || current.id !== incoming.id) return incoming;
    const currentTerminal = TERMINAL_STATES.indexOf(current.state) >= 0;
    const incomingTerminal = TERMINAL_STATES.indexOf(incoming.state) >= 0;
    if (currentTerminal && !incomingTerminal) return current;
    const currentTime = Date.parse(current.updatedAt);
    const incomingTime = Date.parse(incoming.updatedAt);
    if (incomingTime < currentTime) return current;
    if (incomingTime === currentTime) {
        if (currentTerminal && !incomingTerminal) return current;
        if (STATE_PROGRESS[incoming.state] < STATE_PROGRESS[current.state]) return current;
        // Detail carries bounded events that a list row deliberately omits.
        if (Array.isArray(current.events) && current.events.length > 0
                && (!Array.isArray(incoming.events) || incoming.events.length === 0))
            return current;
    }
    return incoming;
}

function summary(row) {
    if (!row) return "";
    if (row.state === "completed") {
        const result = typeof row.resultPreview === "string" ? row.resultPreview.trim() : "";
        return result === "" ? "Completed without a text result." : result;
    }
    if (row.state === "failed") return "The worker failed safely. Inspect its progress events.";
    if (row.state === "cancelled") return "Cancelled after the native worker stopped.";
    if (row.state === "interrupted") return "Interrupted when the daemon stopped or recovered.";
    const events = Array.isArray(row.events) ? row.events : [];
    if (events.length > 0) return events[events.length - 1].message;
    return stateLabel(row.state) + ".";
}
