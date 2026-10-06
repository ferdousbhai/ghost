.pragma library

// TurnBlocks — how a turn becomes messages in the reading column.
//
// Every text the ghost writes stays, and text that follows a tool call is its
// next message, the way a chat app shows a burst of replies; the calls belong
// to the message before them. The live stream (Ghostd opens a row at that
// boundary) and a restored transcript (`rows`) cut in the same place.

function isTool(part) {
    return part.type === "toolCall";
}

function isText(part) {
    return part.type === "text" && part.text.trim() !== "";
}

/** A message's markdown: its text parts in order. */
function fromParts(parts) {
    return parts.filter(isText).map(function (part) {
        return part.text;
    }).join("\n\n");
}

/**
 * Regroup a stored conversation into the rows the live stream would have made.
 *
 * One turn may be stored as several consecutive assistant messages, and one
 * stored message may hold several of the ghost's: rows are cut where text
 * follows a tool call, as the live stream cuts them. A row with no text
 * survives when it still holds a tool call or a failure.
 *
 * Returns `[{ role, text, parts, contentTruncated, error }]`; an assistant
 * row's `parts` is its ordered content, for recovering its tool cards, and
 * `error` is the failed turn's `errorMessage`. Only an owner or hook message
 * is ever marked `contentTruncated`.
 */
function rows(messages) {
    var out = [];
    var parts = [];
    var error = "";

    function commit() {
        var text = fromParts(parts);
        var carriesTool = parts.some(isTool);
        if (text !== "" || carriesTool || error !== "")
            out.push({ role: "assistant", text: text, parts: parts, error: error });
        parts = [];
        error = "";
    }

    for (var i = 0; i < messages.length; i++) {
        var message = messages[i];
        if (message.role === "assistant") {
            for (var p = 0; p < message.content.length; p++) {
                var part = message.content[p];
                if (isText(part) && parts.some(isTool)) commit();
                parts.push(part);
            }
            if (message.errorMessage) error = message.errorMessage;
            continue;
        }
        commit();
        var text = fromParts(message.content);
        if (text === "") continue;
        out.push({ role: message.role, text: text, contentTruncated: message.contentTruncated === true });
    }
    commit();
    return out;
}
