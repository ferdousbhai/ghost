.pragma library

// TurnBlocks — what a turn shows in the reading column, and what its tool
// cards say they are for.
//
// A model narrates itself: "Checking your Dropbox for the invoice", then a
// tool call, then the answer. One structural rule covers it, with no
// classifier, length limit, or sentence counting: the column shows the latest
// text of the turn. Text that a tool call followed was the ghost announcing
// that call, so the next text overwrites it in place and the final answer is
// simply the last block. Nothing is discarded — the announcement survives as
// the intent of the tool card it preceded, which is where it explains
// something.
//
// Both the live stream (content indices) and a restored transcript (ordered
// content parts) carry the order this needs.

function oneLine(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
}

function ascending(a, b) {
    return a - b;
}

/**
 * Split an assistant turn.
 *
 * `blocks` maps content index → `{ kind, text }` (text blocks only), matching
 * the buffer the SSE reader fills. `toolIndices` are the content indices that
 * carry tool calls.
 *
 * Returns `{ body, captions }`: the reply markdown — the text after the last
 * tool call, or the latest text before it while the turn is still inside its
 * calls — and, per tool content index, the narration that announced that
 * call (one line, "" when the ghost called it silently). Consecutive calls
 * with no text between them share one announcement.
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
        // `trim`, not `oneLine`: this only asks whether the block is blank, and
        // collapsing a reply that grows on every tick is quadratic work.
        if (block && block.kind === "text" && String(block.text || "").trim() !== "")
            order.push(Number(keys[k]));
    }
    order.sort(ascending);

    var captions = {};
    var run = [];            // the text blocks since the last tool call
    var announced = [];      // the last run a tool call followed
    var closed = false;      // a tool call has followed `run`
    for (var i = 0; i < order.length; i++) {
        var index = order[i];
        if (isTool[index]) {
            // Every call in a run of calls shares the announcement before it.
            captions[index] = oneLine(run.join(" "));
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
    // Text after the last call is the reply; inside the calls, the column
    // keeps the latest announcement rather than going blank.
    return { body: (closed ? announced : run).join("\n\n"), captions: captions };
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
 * Older storage projections may give one turn several consecutive assistant
 * messages. Regrouping keeps a restored answer in one row, split the way the
 * live stream would have shown it.
 *
 * A row with no text survives when it still holds a tool call. That is the only
 * thing standing between an unanswered `ask` and a dead conversation: its
 * message is a lone `toolCall` part, so dropping the row takes the card's
 * re-answer branch with it and the question can never be answered.
 *
 * Returns `[{ role, text, parts, entryId, contentTruncated }]`; `parts` is the
 * row's ordered content, for a caller that recovers tool cards from it.
 */
function rows(messages) {
    var out = [];
    var parts = [];
    var head = null;
    var contentTruncated = false;

    function commit() {
        if (head === null) return;
        var text = fromParts(parts);
        var carriesTool = parts.some(function (part) {
            return part && part.type === "toolCall";
        });
        if (text !== "" || carriesTool) {
            out.push({
                role: "assistant",
                text: text,
                parts: parts,
                entryId: typeof head.entryId === "string" ? head.entryId : "",
                contentTruncated: contentTruncated
            });
        }
        parts = [];
        head = null;
        contentTruncated = false;
    }

    for (var i = 0; i < (messages || []).length; i++) {
        var message = messages[i];
        if (!message) continue;
        if (message.role === "assistant") {
            if (head === null) head = message;
            // push.apply, not concat: a restored turn is one message per tool
            // call, and concat copies the whole accumulator each time.
            Array.prototype.push.apply(parts, partsOf(message));
            if (message.contentTruncated === true) contentTruncated = true;
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
            entryId: typeof message.entryId === "string" ? message.entryId : "",
            contentTruncated: message.contentTruncated === true
        });
    }
    commit();
    return out;
}

/** The same split over a stored message's ordered content parts. */
function splitParts(parts) {
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

function fromParts(parts) {
    return splitParts(parts).body;
}
