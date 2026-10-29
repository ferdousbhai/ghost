.pragma library

// What of a reply is read aloud: its opening, as a person would say it.
// Markdown's marks are dropped, a link is its label, a code block is
// mentioned rather than read, and only the first paragraph of prose (and at
// most `limit` characters of it) is spoken; the card or the chat shows the
// rest. Pure, so a reply streams through it a delta at a time and each call
// sees the same opening grow.

var CODE_ON_SCREEN = "The code is on screen.";

/** The markdown of one paragraph as plain spoken text. */
function plain(paragraph) {
    return paragraph
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
        .replace(/https?:\/\/\S+/g, "a link")
        .replace(/^\s{0,3}#{1,6}\s+/gm, "")
        .replace(/^\s{0,3}>\s?/gm, "")
        .replace(/^\s*(?:[-+*]|\d{1,9}[.)])\s+/gm, "")
        .replace(/(\*\*|__|\*|_|~~|`)/g, "")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * The spoken opening of `markdown`: its first paragraph of prose, with a
 * heading above it kept as its lead-in, cut at a sentence end within
 * `limit` characters. A reply that opens with code says the code is there.
 */
function opening(markdown, limit) {
    var blocks = String(markdown || "").replace(/\r/g, "").split(/\n\s*\n/);
    var spoken = [];
    for (var i = 0; i < blocks.length; i++) {
        var block = blocks[i];
        if (/^\s{0,3}(```|~~~)/.test(block)) {
            spoken.push(CODE_ON_SCREEN);
            break;
        }
        if (/^\s*\|/.test(block)) continue;
        var text = plain(block);
        if (text === "") continue;
        spoken.push(text);
        // A heading leads into the paragraph under it; anything else is the opening.
        if (!/^\s{0,3}#{1,6}\s/.test(block)) break;
    }
    return clip(spoken.join(" "), limit);
}

/** `text` cut at the last sentence end within `limit`, or at a word if none. */
function clip(text, limit) {
    if (text.length <= limit) return text;
    var cut = text.slice(0, limit);
    var end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    if (end > limit / 3) return cut.slice(0, end + 1);
    var space = cut.lastIndexOf(" ");
    return (space > 0 ? cut.slice(0, space) : cut) + "…";
}

/**
 * The sentences of `text` complete so far, and the unfinished rest. A
 * sentence is complete once its end mark is followed by more text, so a
 * reply streaming in is spoken a sentence at a time.
 */
function sentences(text) {
    var done = [];
    var re = /[^.!?…]*[.!?…]+["')\]]*\s+/g;
    var at = 0;
    var match;
    while ((match = re.exec(text)) !== null) {
        if (match.index !== at) break;
        done.push(match[0].trim());
        at = re.lastIndex;
    }
    return { done: done, rest: text.slice(at).trim() };
}
