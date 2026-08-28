.pragma library

// The owner's hooks.json as the Hooks pane edits it. The daemon's document is
// `{ hooks: { <event>: [ { hooks: [ handler, ... ] }, ... ] } }`, where a
// handler is `{ type: "command", command, name?, description?, timeout?,
// idleSeconds?, ... }`. These helpers flatten that into the pane's cards and
// apply one edit back onto a copy of the document, keeping every key they do
// not know about. A `builtin.<key>` object tunes a hook the daemon registers
// in code; the daemon reads it at startup, so such an edit is pending until
// ghostd restarts. The daemon's loader is the only validator: a refused
// document comes back as its message, never as a rule re-implemented here.

const EVENT_ORDER = ["before_prompt", "session_stop", "conversation_idle"];
const DRAFT_KEY = "draft";

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function clone(document) {
    return isObject(document) ? JSON.parse(JSON.stringify(document)) : {};
}

/** `{ path, document }` from a config response body, or null when it is not that. */
function parseConfig(body) {
    let parsed;
    try {
        parsed = JSON.parse(body);
    } catch (error) {
        return null;
    }
    if (!isObject(parsed) || typeof parsed.path !== "string" || parsed.path === ""
            || !isObject(parsed.document)) return null;
    return { path: parsed.path, document: parsed.document };
}

/** The document's handlers in the daemon's own order: event order, then file order. */
function handlers(document) {
    const out = [];
    if (!isObject(document) || !isObject(document.hooks)) return out;
    for (let e = 0; e < EVENT_ORDER.length; e += 1) {
        const event = EVENT_ORDER[e];
        const groups = document.hooks[event];
        if (!Array.isArray(groups)) continue;
        for (let g = 0; g < groups.length; g += 1) {
            const group = groups[g];
            if (!isObject(group) || !Array.isArray(group.hooks)) continue;
            for (let h = 0; h < group.hooks.length; h += 1) {
                if (isObject(group.hooks[h])) {
                    out.push({ event, groupIndex: g, handlerIndex: h, handler: group.hooks[h] });
                }
            }
        }
    }
    return out;
}

function blankFields() {
    return { command: "", name: "", description: "", timeout: "", idleSeconds: "" };
}

/** The editable fields of one handler as typed text; absent fields are "". */
function fieldsOf(handler) {
    const fields = blankFields();
    if (!isObject(handler)) return fields;
    for (const key in fields) fields[key] = text(handler[key]);
    return fields;
}

/**
 * The pane's rows. Built-in hooks come from the status and are read-only.
 * Config hooks come from the document, which is what an edit changes; the
 * daemon emits its config status rows in the order it read the file, so the
 * n-th config row of an event resolves the n-th document handler's display
 * name and description (the daemon fills defaults the file leaves out). When
 * the two disagree — a status fetch that failed after a write — the document
 * wins and the row shows what the file says.
 */
function cards(statusHooks, document) {
    const rows = Array.isArray(statusHooks) ? statusHooks : [];
    // Anything the daemon did not mark as config is shown read-only.
    const builtin = rows.filter(function (row) { return row.source !== "config"; });
    const configRows = rows.filter(function (row) { return row.source === "config"; });
    const entries = handlers(document);
    const aligned = configRows.length === entries.length && entries.every(function (entry, index) {
        return configRows[index].event === entry.event;
    });
    const out = [];
    for (let e = 0; e < EVENT_ORDER.length; e += 1) {
        const event = EVENT_ORDER[e];
        for (let b = 0; b < builtin.length; b += 1) {
            const row = builtin[b];
            if (row.event !== event) continue;
            const settingsKey = typeof row.settingsKey === "string" ? row.settingsKey : "";
            const tuning = builtinTuning(document, settingsKey);
            const fields = blankFields();
            fields.idleSeconds = text(tuning.idleSeconds);
            const configured = Number(fields.idleSeconds);
            out.push({
                key: "builtin:" + event + ":" + b,
                source: "builtin",
                event,
                name: row.name,
                description: row.description,
                idleSeconds: row.idleSeconds || 0,
                settingsKey,
                // The file says one thing and the running daemon another: a
                // restart is what applies it.
                pendingIdleSeconds: settingsKey !== "" && fields.idleSeconds !== ""
                    && configured !== (row.idleSeconds || 0) ? configured : 0,
                command: "",
                fields,
                groupIndex: -1,
                handlerIndex: -1
            });
        }
        for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            if (entry.event !== event) continue;
            const status = aligned ? configRows[i] : null;
            const fields = fieldsOf(entry.handler);
            const idle = Number(fields.idleSeconds);
            out.push({
                key: "config:" + event + ":" + entry.groupIndex + ":" + entry.handlerIndex,
                source: "config",
                event,
                settingsKey: "",
                pendingIdleSeconds: 0,
                name: status ? status.name : (fields.name === "" ? "Command hook" : fields.name),
                description: status ? status.description : fields.description,
                idleSeconds: status ? status.idleSeconds || 0
                    : (Number.isSafeInteger(idle) && idle > 0 ? idle : 0),
                command: fields.command,
                fields,
                groupIndex: entry.groupIndex,
                handlerIndex: entry.handlerIndex
            });
        }
    }
    return out;
}

/** The `builtin.<key>` object of `document`, or `{}`. */
function builtinTuning(document, key) {
    if (key === "" || !isObject(document) || !isObject(document.builtin)
            || !isObject(document.builtin[key])) return {};
    return document.builtin[key];
}

/**
 * `document` with `builtin.<key>.idleSeconds` set from `fields`; an emptied
 * field removes the tuning so the daemon's default applies, and an emptied
 * section goes with it.
 */
function withBuiltinIdle(document, key, fields) {
    const next = clone(document);
    if (!isObject(next.builtin)) next.builtin = {};
    const value = text(fields.idleSeconds).trim();
    if (value === "") {
        delete next.builtin[key];
        if (Object.keys(next.builtin).length === 0) delete next.builtin;
        return next;
    }
    const number = Number(value);
    next.builtin[key] = Object.assign(isObject(next.builtin[key]) ? next.builtin[key] : {},
        { idleSeconds: Number.isFinite(number) ? number : value });
    return next;
}

function find(cardList, key) {
    for (let i = 0; i < cardList.length; i += 1) if (cardList[i].key === key) return cardList[i];
    return null;
}

/**
 * One handler from the fields as typed. An emptied optional field is dropped
 * so the daemon's default applies; a number that does not parse is sent as
 * typed so the daemon's message names the field. `idleSeconds` belongs only
 * to a conversation_idle hook.
 */
function handlerFrom(existing, event, fields) {
    const handler = isObject(existing) ? clone(existing) : {};
    handler.type = "command";
    handler.command = text(fields.command);
    const optional = ["name", "description", "timeout", "idleSeconds"];
    for (let i = 0; i < optional.length; i += 1) {
        const key = optional[i];
        const value = text(fields[key]).trim();
        if (value === "" || (key === "idleSeconds" && event !== "conversation_idle")) {
            delete handler[key];
            continue;
        }
        if (key === "timeout" || key === "idleSeconds") {
            const number = Number(value);
            handler[key] = Number.isFinite(number) ? number : value;
        } else {
            handler[key] = value;
        }
    }
    return handler;
}

function groupsOf(document, event) {
    if (!isObject(document.hooks)) document.hooks = {};
    if (!Array.isArray(document.hooks[event])) document.hooks[event] = [];
    return document.hooks[event];
}

/** `document` with the handler at (event, groupIndex, handlerIndex) replaced by `fields`. */
function withHandler(document, event, groupIndex, handlerIndex, fields) {
    const next = clone(document);
    const group = groupsOf(next, event)[groupIndex];
    if (!isObject(group) || !Array.isArray(group.hooks)) return next;
    group.hooks[handlerIndex] = handlerFrom(group.hooks[handlerIndex], event, fields);
    return next;
}

/** `document` with a new handler appended as its own group at the end of `event`. */
function withNewHandler(document, event, fields) {
    const next = clone(document);
    groupsOf(next, event).push({ hooks: [handlerFrom(null, event, fields)] });
    return next;
}

/** `document` without that handler; an emptied group or event goes with it. */
function withoutHandler(document, event, groupIndex, handlerIndex) {
    const next = clone(document);
    const groups = groupsOf(next, event);
    const group = groups[groupIndex];
    if (isObject(group) && Array.isArray(group.hooks)) {
        group.hooks.splice(handlerIndex, 1);
        if (group.hooks.length === 0) groups.splice(groupIndex, 1);
    }
    if (groups.length === 0) delete next.hooks[event];
    return next;
}

function same(left, right) {
    return JSON.stringify(clone(left)) === JSON.stringify(clone(right));
}
