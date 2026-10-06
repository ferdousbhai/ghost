.pragma library

// TurnBlocks — what a turn shows in the reading column.
//
// A model narrates itself: "Checking your Dropbox for the invoice", then a
// tool call, then the answer. One structural rule covers it, with no
// classifier, length limit, or sentence counting: the column shows the latest
// text of the turn. Text a tool call followed was the ghost announcing that
// call; it holds the column while the call runs, and the next text replaces
// it, so the final answer is simply the last run of text.
//
// Both the live stream (content indices) and a restored transcript (ordered
// content parts) carry the order this needs.

function ascending(a, b) {
    return a - b;
}

/**
 * The reply markdown of an assistant turn: the text after the last tool call,
 * or the latest text before it while the turn is still inside its calls.
 *
 * `blocks` maps content index → `{ kind, text }` (text blocks only), matching
 * the buffer the SSE reader fills. `toolIndices` are the positions of the tool
 * calls among those indices; a live call's is fractional (Ghostd.toolSlot).
 */
function split(blocks, toolIndices) {
    // One walk over every content index in order, text and tool call alike.
    var isTool = {};
    var order = [];
    var raw = toolIndices || [];
    for (var t = 0; t < raw.length; t++) {
        var tool = Number(raw[t]);
        if (isNaN(tool)) continue;
        isTool[tool] = true;
        order.push(tool);
    }
    var keys = Object.keys(blocks || {});
    for (var k = 0; k < keys.length; k++) {
        var block = blocks[keys[k]];
        // Only whether the block is blank: collapsing a reply that grows on
        // every tick would be quadratic work.
        if (block && block.kind === "text" && String(block.text || "").trim() !== "")
            order.push(Number(keys[k]));
    }
    order.sort(ascending);

    var run = [];            // the text blocks since the last tool call
    var announced = [];      // the last run a tool call followed
    var closed = false;      // a tool call has followed `run`
    for (var i = 0; i < order.length; i++) {
        var index = order[i];
        if (isTool[index]) {
            if (run.length > 0) announced = run;
            closed = true;
            continue;
        }
        if (closed) {
            run = [];
            closed = false;
        }
        run.push(blocks[index].text);
    }
    return (closed ? announced : run).join("\n\n");
}

function partsOf(message) {
    if (Array.isArray(message.content)) return message.content;
    if (typeof message.content === "string" && message.content !== "")
        return [{ type: "text", text: message.content }];
    if (typeof message.text === "string" && message.text !== "")
        return [{ type: "text", text: message.text }];
    return [];
}

/**
 * Regroup a stored conversation into the rows the live stream would have made.
 *
 * One turn may be stored as several consecutive assistant messages.
 * Regrouping keeps a restored answer in one row, split the way the live stream
 * would have shown it. A row with no text survives when it still holds a tool
 * call or a failure.
 *
 * Returns `[{ role, text, parts, contentTruncated, error }]`; `parts`
 * is the row's ordered content, for a caller that recovers tool cards from it,
 * and `error` is the failed turn's `errorMessage`, or "".
 */
function rows(messages) {
    var out = [];
    var parts = [];
    var open = false;
    var contentTruncated = false;
    var error = "";

    function commit() {
        if (!open) return;
        var text = fromParts(parts);
        var carriesTool = parts.some(function (part) {
            return part && part.type === "toolCall";
        });
        if (text !== "" || carriesTool || error !== "") {
            out.push({
                role: "assistant",
                text: text,
                parts: parts,
                contentTruncated: contentTruncated,
                error: error
            });
        }
        parts = [];
        open = false;
        contentTruncated = false;
        error = "";
    }

    for (var i = 0; i < (messages || []).length; i++) {
        var message = messages[i];
        if (!message) continue;
        if (message.role === "assistant") {
            open = true;
            // push.apply, not concat: a restored turn is one message per tool
            // call, and concat copies the whole accumulator each time.
            Array.prototype.push.apply(parts, partsOf(message));
            if (message.contentTruncated === true) contentTruncated = true;
            if (typeof message.errorMessage === "string" && message.errorMessage !== "")
                error = message.errorMessage;
            continue;
        }
        if (message.role === "hook") {
            commit();
            var hookParts = partsOf(message);
            var notice = fromParts(hookParts);
            if (notice === "") continue;
            out.push({
                role: "hook",
                text: notice,
                parts: hookParts,
                contentTruncated: message.contentTruncated === true
            });
            continue;
        }
        if (message.role !== "user") continue;
        commit();
        var userParts = partsOf(message);
        var prompt = fromParts(userParts);
        if (prompt === "") continue;
        out.push({
            role: "user",
            text: prompt,
            parts: userParts,
            contentTruncated: message.contentTruncated === true
        });
    }
    commit();
    return out;
}

/** The same reply over a stored message's ordered content parts. */
function fromParts(parts) {
    var blocks = {};
    var toolIndices = [];
    for (var i = 0; i < (parts || []).length; i++) {
        var part = parts[i];
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string")
            blocks[i] = { kind: "text", text: part.text };
        else if (part.type === "toolCall")
            toolIndices.push(i);
    }
    return split(blocks, toolIndices);
}
