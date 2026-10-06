.pragma library

// TurnBlocks — what a turn shows in the reading column.
//
// A model narrates itself: "Checking your Dropbox for the invoice", then a
// tool call, then the answer. One structural rule covers it, with no
// classifier, length limit, or sentence counting: the column shows the latest
// text of the turn. Text a tool call followed was the ghost announcing that
// call; it holds the column while the call runs, and the next text replaces
// it, so the final answer is simply the last run of text. The live stream and
// a restored transcript both give it ordered content parts.

/**
 * The reply markdown of an assistant turn's ordered content parts: the text
 * after the last tool call, or the latest text before it while the turn is
 * still inside its calls.
 */
function fromParts(parts) {
    var run = [];            // the text parts since the last tool call
    var announced = [];      // the last run a tool call followed
    var closed = false;      // a tool call has followed `run`
    for (var i = 0; i < (parts || []).length; i++) {
        var part = parts[i];
        if (!part) continue;
        if (part.type === "toolCall") {
            if (run.length > 0) announced = run;
            closed = true;
            continue;
        }
        if (part.type !== "text" || String(part.text || "").trim() === "") continue;
        if (closed) {
            run = [];
            closed = false;
        }
        run.push(part.text);
    }
    return (closed ? announced : run).join("\n\n");
}

/**
 * Regroup a stored conversation into the rows the live stream would have made.
 *
 * One turn may be stored as several consecutive assistant messages.
 * Regrouping keeps a restored answer in one row, shown the way the live stream
 * would have shown it. A row with no text survives when it still holds a tool
 * call or a failure.
 *
 * Returns `[{ role, text, parts, contentTruncated, error }]`; an assistant
 * row's `parts` is its ordered content, for recovering its tool cards, and
 * `error` is the failed turn's `errorMessage`. Only an owner or hook message
 * is ever marked `contentTruncated`.
 */
function rows(messages) {
    var out = [];
    var parts = [];
    var open = false;
    var error = "";

    function commit() {
        if (!open) return;
        var text = fromParts(parts);
        var carriesTool = parts.some(function (part) {
            return part && part.type === "toolCall";
        });
        if (text !== "" || carriesTool || error !== "")
            out.push({ role: "assistant", text: text, parts: parts, error: error });
        parts = [];
        open = false;
        error = "";
    }

    for (var i = 0; i < (messages || []).length; i++) {
        var message = messages[i];
        if (!message) continue;
        var content = Array.isArray(message.content) ? message.content : [];
        if (message.role === "assistant") {
            open = true;
            // push.apply, not concat: a restored turn is one message per tool
            // call, and concat copies the whole accumulator each time.
            Array.prototype.push.apply(parts, content);
            if (typeof message.errorMessage === "string" && message.errorMessage !== "")
                error = message.errorMessage;
            continue;
        }
        if (message.role !== "user" && message.role !== "hook") continue;
        commit();
        var text = fromParts(content);
        if (text === "") continue;
        out.push({ role: message.role, text: text, contentTruncated: message.contentTruncated === true });
    }
    commit();
    return out;
}
