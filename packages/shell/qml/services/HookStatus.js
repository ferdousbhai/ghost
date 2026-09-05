.pragma library

const EVENT_ORDER = ["before_prompt", "session_stop"];
const ROOT_KEYS = ["active", "events", "hooks", "total"];
const EVENT_KEYS = ["count", "event"];
const HOOK_KEYS = ["description", "event", "name", "source"];
const SOURCES = ["builtin", "config"];
const SETTINGS_KEY = /^[a-z][a-z0-9_]*$/;

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object, key);
}

function exactKeys(object, expected) {
    const keys = Object.keys(object).sort();
    const wanted = expected.slice().sort();
    if (keys.length !== wanted.length) return false;
    for (let index = 0; index < keys.length; index += 1) {
        if (keys[index] !== wanted[index]) return false;
    }
    return true;
}

function eventIndex(event) {
    return EVENT_ORDER.indexOf(event);
}

function boundedDisplayText(value, maximum) {
    return typeof value === "string" && value.length >= 1
        && value.length <= maximum && value === value.trim();
}

/**
 * Validate the daemon's complete redacted status projection. No partial or
 * repaired value is displayed: an inconsistent count could otherwise make a
 * hidden handler appear absent, and flooring idle timing would change meaning.
 */
function normalize(body) {
    if (!isObject(body) || !exactKeys(body, ROOT_KEYS)
            || typeof body.active !== "boolean"
            || !Number.isSafeInteger(body.total) || body.total < 0
            || !Array.isArray(body.events) || !Array.isArray(body.hooks)) return null;

    const counts = Object.create(null);
    let previousEventIndex = -1;
    let eventTotal = 0;
    const events = [];
    for (let index = 0; index < body.events.length; index += 1) {
        const entry = body.events[index];
        if (!isObject(entry) || !exactKeys(entry, EVENT_KEYS)
                || eventIndex(entry.event) <= previousEventIndex
                || !Number.isSafeInteger(entry.count) || entry.count < 1) return null;
        previousEventIndex = eventIndex(entry.event);
        counts[entry.event] = entry.count;
        eventTotal += entry.count;
        if (!Number.isSafeInteger(eventTotal)) return null;
        events.push({ event: entry.event, count: entry.count });
    }

    const observed = Object.create(null);
    let previousHookEventIndex = -1;
    const hooks = [];
    for (let index = 0; index < body.hooks.length; index += 1) {
        const hook = body.hooks[index];
        if (!isObject(hook) || !boundedDisplayText(hook.name, 80)
                || !boundedDisplayText(hook.description, 240)
                || SOURCES.indexOf(hook.source) < 0) return null;
        const order = eventIndex(hook.event);
        if (order < 0 || order < previousHookEventIndex) return null;
        previousHookEventIndex = order;
        // Only a built-in row may name the hooks.json entry that tunes it.
        const tuned = hasOwn(hook, "settingsKey");
        if (tuned && (hook.source !== "builtin" || typeof hook.settingsKey !== "string"
                || !SETTINGS_KEY.test(hook.settingsKey))) return null;
        if (!exactKeys(hook, HOOK_KEYS.concat(tuned ? ["settingsKey"] : []))) return null;
        observed[hook.event] = (observed[hook.event] || 0) + 1;
        const normalized = {
            event: hook.event,
            source: hook.source,
            name: hook.name,
            description: hook.description
        };
        if (tuned) normalized.settingsKey = hook.settingsKey;
        hooks.push(normalized);
    }

    if (body.total !== hooks.length || body.total !== eventTotal
            || body.active !== (body.total > 0)) return null;
    for (let index = 0; index < EVENT_ORDER.length; index += 1) {
        const event = EVENT_ORDER[index];
        if ((counts[event] || 0) !== (observed[event] || 0)) return null;
    }
    return {
        active: body.active,
        total: body.total,
        events,
        hooks
    };
}

function label(event) {
    if (event === "before_prompt") return "Before prompt";
    if (event === "session_stop") return "Session stop";
    return "";
}

function trigger(event) {
    if (event === "before_prompt") return "Before each owner prompt";
    if (event === "session_stop") return "After each assistant pass";
    return "";
}
