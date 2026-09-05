.pragma library
.import "HookStatus.js" as HookStatus

// The owner's hooks.json as the Hooks pane edits it. The daemon's document is
// `{ hooks: { <event>: [ { hooks: [ handler, ... ] }, ... ] } }`, where a
// handler is `{ type: "command", command, name?, description?, timeout?, ... }`.
// These helpers flatten that into the pane's cards and apply one edit back onto
// a copy of the document, keeping every key they do not know about. The
// daemon's loader is the only validator: a refused document comes back as its
// message, never as a rule re-implemented here.

const EVENT_ORDER = HookStatus.EVENT_ORDER;
const DRAFT_KEY = "draft";
const isObject = HookStatus.isObject;

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function trimmed(fields, key) {
    return text(fields[key]).trim();
}

/** A number if it parses, else as typed so the daemon's message names the field. */
function numberOrText(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
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
    return { command: "", name: "", description: "", timeout: "" };
}

/** One pane row; `fields` is what its edit form starts from. */
function card(overrides) {
    return Object.assign({
        key: "",
        source: "config",
        event: "",
        name: "",
        description: "",
        settingsKey: "",
        fields: blankFields(),
        groupIndex: -1,
        handlerIndex: -1
    }, overrides);
}

/** The row a new command hook is drafted in; its event lives on the pane. */
function draftCard() {
    return card({ key: DRAFT_KEY });
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
            out.push(card({
                key: "builtin:" + event + ":" + b,
                source: "builtin",
                event,
                name: row.name,
                description: row.description,
                settingsKey: typeof row.settingsKey === "string" ? row.settingsKey : ""
            }));
        }
        for (let i = 0; i < entries.length; i += 1) {
            const entry = entries[i];
            if (entry.event !== event) continue;
            const status = aligned ? configRows[i] : null;
            const fields = fieldsOf(entry.handler);
            out.push(card({
                key: "config:" + event + ":" + entry.groupIndex + ":" + entry.handlerIndex,
                event,
                name: status ? status.name : (fields.name === "" ? "Command hook" : fields.name),
                description: status ? status.description : fields.description,
                fields,
                groupIndex: entry.groupIndex,
                handlerIndex: entry.handlerIndex
            }));
        }
    }
    return out;
}

function find(cardList, key) {
    for (let i = 0; i < cardList.length; i += 1) if (cardList[i].key === key) return cardList[i];
    return null;
}

/**
 * One handler from the fields as typed. An emptied optional field is dropped
 * so the daemon's default applies.
 */
function handlerFrom(existing, fields) {
    const handler = isObject(existing) ? clone(existing) : {};
    handler.type = "command";
    handler.command = text(fields.command);
    const optional = ["name", "description", "timeout"];
    for (let i = 0; i < optional.length; i += 1) {
        const key = optional[i];
        const value = trimmed(fields, key);
        if (value === "") {
            delete handler[key];
            continue;
        }
        handler[key] = key === "timeout" ? numberOrText(value) : value;
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
    group.hooks[handlerIndex] = handlerFrom(group.hooks[handlerIndex], fields);
    return next;
}

/** `document` with a new handler appended as its own group at the end of `event`. */
function withNewHandler(document, event, fields) {
    const next = clone(document);
    groupsOf(next, event).push({ hooks: [handlerFrom(null, fields)] });
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
