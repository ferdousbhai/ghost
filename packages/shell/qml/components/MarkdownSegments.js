.pragma library

// MarkdownSegments — how a reply that is still arriving gets on screen without
// re-reading everything already on it.
//
// Qt's Text has one way to render markdown: hand it a document and it parses
// the document. A streaming reply grows by a few characters every flush tick,
// so re-handing it the accumulated body costs the whole body each time —
// quadratic in the length of the answer, and the jank lands on the HUD exactly
// while the ghost is worth watching.
//
// What makes that avoidable is that markdown is mostly already settled: nothing
// before the block currently being written can change again. This scanner walks
// the body once, carrying its position between calls, and closes a *segment*
// each time it reaches a blank line that safely ends a top-level block. The
// caller renders every closed segment as its own document — parsed once, then
// never touched — and only the tail keeps being re-read.
//
// A boundary is taken only where two documents render as one. Never inside a
// fence; never before a line set in from the margin, which is a list item's own
// continuation or an indented code block; never between two lists, because a
// blank line between items makes one loose list and splitting it would restart
// an ordered one; and never around a link reference definition or a raw HTML
// block, whose meaning reaches across the gap. Everything else — paragraphs,
// headings, fenced code, quotes, tables, thematic breaks — is self-contained
// between blank lines.
//
// A block closes only once the first line of the block after it has arrived
// whole, because that line is what decides whether the two may be parted. The
// last line of a turn never gets its newline, so a caller that knows the turn
// has settled says so and the scan reads that line as the finished thing it is.
//
// The segments are cuts of the body, not a rewrite of it: joined back together
// they are the body, character for character, so the reader sees what a single
// document would have shown.

/** Block kinds whose meaning does not stop at the blank line beside them. */
var REACHES_ACROSS = { linkref: true, html: true };

/** A scan of nothing, ready to be advanced over a body. */
function begin() {
    return { closed: "", at: 0, blockKind: "", blank: false, fence: "" };
}

/**
 * Fold whatever `body` has gained into `cursor` (mutated), and report:
 *
 *   `reset`    `body` does not continue what the cursor had already closed —
 *              a transcript row reused for another message, or a turn re-split
 *              once it settled. The caller drops what it has rendered first.
 *   `segments` newly closed segments, in order, each already final.
 *   `tail`     everything not closed yet; the only part still worth re-reading.
 *
 * `settled` says the body will not grow again, which is what lets the last line
 * of the turn close the block before it.
 */
function advance(body, cursor, settled) {
    var text = String(body || "");
    // Whether this body still starts with what has been closed. It compares the
    // settled prefix on every call, which is the one thing here that is not
    // bounded by the new characters — but it is a string compare, not a parse,
    // and it is what stands between a reused row and someone else's answer
    // stitched onto the blocks already on screen.
    var reset = text.length < cursor.closed.length
        || text.lastIndexOf(cursor.closed, 0) !== 0;
    if (reset) {
        cursor.closed = "";
        cursor.at = 0;
        cursor.blockKind = "";
        cursor.blank = false;
        cursor.fence = "";
    }

    var segments = [];
    function close(boundary) {
        if (boundary < 0) return;
        var segment = text.substring(cursor.closed.length, boundary);
        segments.push(segment);
        // Appended, not re-sliced from the start: the prefix is already right,
        // and re-cutting it would copy the whole answer at every boundary.
        cursor.closed += segment;
    }

    var from = cursor.at;
    for (;;) {
        // A line without its newline is still arriving: what it starts cannot
        // be classified yet, so the scan stops here and resumes on it.
        var end = text.indexOf("\n", from);
        if (end < 0) break;
        close(step(cursor, text.substring(from, end), from));
        from = end + 1;
    }
    if (settled && from < text.length) {
        close(step(cursor, text.substring(from), from));
        from = text.length;
    }
    cursor.at = from;

    return {
        reset: reset,
        segments: segments,
        tail: text.substring(cursor.closed.length)
    };
}

/**
 * Take one complete line. Returns the offset where a segment closes — always
 * the start of the line that begins the next block — or -1 for no boundary.
 */
function step(cursor, line, lineStart) {
    if (cursor.fence !== "") {
        if (closesFence(line, cursor.fence)) cursor.fence = "";
        return -1;
    }
    if (line.trim() === "") {
        cursor.blank = true;
        return -1;
    }

    var kind = classify(line);
    var boundary = cursor.blank && cursor.blockKind !== ""
        && splits(cursor.blockKind, kind) ? lineStart : -1;
    // Only a line after a blank one starts a block; the rest continue the block
    // already open, whatever they look like on their own.
    if (cursor.blank || cursor.blockKind === "") cursor.blockKind = kind;
    cursor.blank = false;

    // A fence may interrupt a paragraph, so this is asked of every line, and
    // asked of the line as trimmed: a fence opened inside a list item is
    // indented, and missing it would let a blank line inside its code look
    // like the end of a block.
    var fence = opensFence(line);
    if (fence !== "") {
        cursor.fence = fence;
        cursor.blockKind = "fence";
    }
    return boundary;
}

function splits(before, after) {
    if (REACHES_ACROSS[before] || REACHES_ACROSS[after]) return false;
    if (after === "indented") return false;
    return !(before === "list" && after === "list");
}

function classify(line) {
    var indent = 0;
    var start = 0;
    while (start < line.length) {
        if (line[start] === " ") indent += 1;
        else if (line[start] === "\t") indent += 4;
        else break;
        start += 1;
    }
    // A top-level block starts at the margin. Anything set in from it belongs
    // to the block above — a list item's continuation, or indented code.
    if (indent > 0) return "indented";

    var rest = line.substring(start);
    if (/^(?:`{3,}|~{3,})/u.test(rest)) return "fence";
    if (/^#{1,6}(?:\s|$)/u.test(rest)) return "heading";
    if (/^(?:\*[ \t]*){3,}$|^(?:-[ \t]*){3,}$|^(?:_[ \t]*){3,}$/u.test(rest)) return "break";
    if (/^[-+*](?:[ \t]|$)/u.test(rest)) return "list";
    if (/^\d{1,9}[.)](?:[ \t]|$)/u.test(rest)) return "list";
    if (/^>/u.test(rest)) return "quote";
    if (/^\|/u.test(rest)) return "table";
    if (/^\[[^\]]*\]:/u.test(rest)) return "linkref";
    if (/^</u.test(rest)) return "html";
    return "paragraph";
}

/** The fence character a line opens with, or "" if it opens none. */
function opensFence(line) {
    var match = /^[ \t]*(`{3,}|~{3,})/u.exec(line);
    return match ? match[1].charAt(0) : "";
}

function closesFence(line, marker) {
    var trimmed = line.trim();
    if (trimmed.length < 3) return false;
    for (var i = 0; i < trimmed.length; i++)
        if (trimmed.charAt(i) !== marker) return false;
    return true;
}
