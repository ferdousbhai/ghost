.pragma library

// TurnBlocks — which of a turn's text belongs in the reading column, and which
// belongs beside the orb.
//
// A model narrates itself: "Checking your Dropbox for the invoice", then a tool
// call, then the answer. That narration is status, not reply. It is worth
// seeing while it happens and worth nothing afterwards, so it goes where the
// summoning indicator already is and leaves the transcript to the answer.
//
// The split needs no classifier. A text block only *becomes* a preamble because
// a tool call came after it — that is structural, and both the live stream
// (content indices) and a restored transcript (ordered content parts) carry it.
// Until that call arrives, a block streams in the reading column like any
// answer: the final text is never known before the end of the stream, so the
// column shows it as it comes and the orb takes a block back only when the
// call that makes it narration actually starts. A short preamble therefore
// appears in the column for a beat and then moves beside the orb — a small,
// honest motion, against holding every short answer out of sight until `done`.

/**
 * Longest a block can be and still be status. A preamble is one sentence by
 * nature, so this is half of the test and {@link sentenceCount} is the other:
 * a longer block, or one that runs on to a second sentence, is a section of a
 * multi-step answer and stays in the reply.
 */
var PREAMBLE_LIMIT = 200;

/**
 * Where a sentence ends: a stop that meets whitespace or the end of the block.
 * A stop inside a word ends nothing — `package.json`, `£4.20` — and narration
 * routinely carries no stop at all ("Checking your Dropbox").
 */
var SENTENCE_END = /[.!?\u2026]+(?:\s|$)/gu;

function oneLine(value) {
    return String(value || "").replace(/\s+/gu, " ").trim();
}

function sentenceCount(text) {
    var matches = String(text || "").match(SENTENCE_END);
    return matches === null ? 0 : matches.length;
}

function isPreamble(text) {
    // The cheap test first: nothing shorter than the limit can grow past it
    // once whitespace is collapsed, and this runs on every 50ms flush tick.
    var within = String(text || "").length <= PREAMBLE_LIMIT
        || oneLine(text).length <= PREAMBLE_LIMIT;
    // Then the other half of the definition above, which the limit alone only
    // approximates. A short block that runs to a second sentence is answering,
    // not announcing, and a block ruled a preamble is *discarded* once the
    // turn settles — so guessing wrong here costs the transcript words the
    // ghost really said. An unpunctuated block counts as one sentence, which
    // keeps the commonest narration shape of all on the status line.
    return within && sentenceCount(text) <= 1;
}

/**
 * Status wears the indicator's own animated ellipsis, so a preamble that
 * already ends in a stop would read as "…the invoice....".
 */
function asStatus(text) {
    return oneLine(text).replace(/[.…]+$/u, "");
}

/**
 * Split an assistant turn.
 *
 * `blocks` maps content index → `{ kind, text }` (text blocks only), matching
 * the buffer the SSE reader fills. `toolIndices` are the content indices that
 * carry tool calls. `streaming` is true while the turn is still open.
 *
 * Returns `{ body, status }`: the reply markdown, and the ghost's own words for
 * what it is doing now (or "" when it is working silently).
 */
function split(blocks, toolIndices, streaming) {
    var lastTool = -1;
    var raw = toolIndices || [];
    for (var t = 0; t < raw.length; t++) {
        var at = Number(raw[t]);
        if (at > lastTool) lastTool = at;
    }

    var indices = Object.keys(blocks || {}).map(Number).sort(function (a, b) {
        return a - b;
    });
    var last = indices.length > 0 ? indices[indices.length - 1] : -1;

    var reply = [];
    // The last text block before the final tool call, and whether it was
    // narration. Only *that* block can describe the call now running: an
    // earlier preamble describes a step already finished, and reporting it
    // would have the orb narrating one step while the column shows the text
    // describing the next.
    var latest = "";
    for (var i = 0; i < indices.length; i++) {
        var index = indices[i];
        var block = blocks[index];
        // `trim`, not `oneLine`: this only asks whether the block is blank, and
        // collapsing a reply that grows on every tick is quadratic work.
        if (!block || block.kind !== "text" || String(block.text || "").trim() === "") continue;
        if (index < lastTool && isPreamble(block.text)) {
            latest = block.text;
        } else {
            if (index < lastTool) latest = "";
            reply.push(block.text);
        }
    }
    // A turn that spent itself entirely on tool calls has nothing else to say.
    // Its last preamble is the reply rather than an empty row.
    if (reply.length === 0 && !streaming && latest !== "")
        return { body: latest.trim(), status: "" };
    // The orb speaks the last preamble only while its tool call is what the
    // turn is doing; once text follows the last call, that text is the reply
    // in progress and the orb reports the runtime's state instead.
    var insideCalls = Boolean(streaming) && lastTool > last;
    return {
        body: reply.join("\n\n"),
        status: insideCalls ? asStatus(latest) : ""
    };
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
 * messages. Regrouping keeps a restored answer in one row and each preamble
 * beside the tool call that made it one.
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

function fromParts(parts) {
    var blocks = {};
    var toolIndices = [];
    for (var i = 0; i < parts.length; i++) {
        var part = parts[i];
        if (!part) continue;
        if (part.type === "text" && typeof part.text === "string")
            blocks[i] = { kind: "text", text: part.text };
        else if (part.type === "toolCall")
            toolIndices.push(i);
    }
    return split(blocks, toolIndices, false).body;
}
