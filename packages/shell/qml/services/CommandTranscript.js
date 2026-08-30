.pragma library

// Standalone Ghost builtins deliberately produce command_output rather than an
// assistant message. The daemon transcript therefore has no row to restore
// after the turn. Keep the small presentation-only exchange beside the stored
// rows, anchored at the number of persisted rows that preceded it.

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function joinedOutput(before, after) {
    const left = text(before);
    const right = text(after);
    if (left === "") return right;
    if (right === "") return left;
    return /\n$/u.test(left) || /^\n/u.test(right) ? left + right : left + "\n" + right;
}

function append(current, event, prompt, anchor) {
    const previous = current || ({});
    return {
        prompt: text(previous.prompt || prompt),
        command: text(previous.command || (event ? event.command : "") || prompt),
        output: joinedOutput(previous.output, event ? event.output : ""),
        isError: previous.isError === true || Boolean(event && event.isError),
        code: text((event && event.code) || previous.code),
        anchor: Number.isFinite(Number(previous.anchor))
            ? Math.max(0, Number(previous.anchor)) : Math.max(0, Number(anchor) || 0)
    };
}

function failure(exchange) {
    if (!exchange || exchange.isError !== true) return "";
    if (exchange.code === "unsupported_command") return "This command is unavailable here.";
    return "Command failed.";
}

function uiRows(exchange) {
    return [{
        role: "user",
        text: text(exchange.prompt || exchange.command),
        parts: [],
        entryId: ""
    }, {
        role: "command",
        text: text(exchange.output),
        parts: [],
        entryId: "",
        error: failure(exchange)
    }];
}

/**
 * Reinsert presentation-only command exchanges without disturbing stored row
 * order. Several consecutive commands can share an anchor; their array order
 * is their live order.
 */
function merge(storedRows, exchanges) {
    const stored = Array.isArray(storedRows) ? storedRows : [];
    const commands = Array.isArray(exchanges) ? exchanges : [];
    const out = [];
    for (let position = 0; position <= stored.length; position++) {
        for (let index = 0; index < commands.length; index++) {
            const exchange = commands[index];
            const anchor = Math.min(stored.length,
                Math.max(0, Number(exchange && exchange.anchor) || 0));
            if (anchor !== position) continue;
            Array.prototype.push.apply(out, uiRows(exchange));
        }
        if (position < stored.length) out.push(stored[position]);
    }
    return out;
}
