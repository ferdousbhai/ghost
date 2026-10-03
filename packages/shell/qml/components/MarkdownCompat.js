.pragma library

// MarkdownCompat — markdown Qt 6.11's renderer no longer formats, rewritten
// into forms it still does, just before a Text renders it.
//
// Qt 6.11.2 consumes `_` and `~` delimiters without applying them: `_i_`,
// `__b__`, `~s~`, and `~~s~~` all render as bare text with the markers gone,
// while `*i*`, `**b**`, and inline `<del>` still format
// (test/tst_markdowncompat.qml pins both halves). So underscore emphasis
// becomes star emphasis and tildes become `<del>`, under CommonMark's
// underscore rule (no intraword emphasis, so `snake_case` stays), and never
// inside fenced code, code spans, link destinations, autolinks, HTML tags, or
// bare URLs. When Qt formats these again, this file is deleted.

// Spans whose bytes must reach Qt untouched, in the order they win.
const PROTECTED = /(`+)[^`]*?\1|\]\([^)\n]*\)|<[^<>\n]+>|https?:\/\/[^\s<>()]+/g;

function rewrite(plain) {
    return plain
        .replace(/(^|[^\w\\~])~~(?=\S)([^~\n]*?\S)~~(?![\w~])/g, "$1<del>$2</del>")
        .replace(/(^|[^\w\\~])~(?=\S)([^~\n]*?\S)~(?![\w~])/g, "$1<del>$2</del>")
        .replace(/(^|[^\w\\_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, "$1**$2**")
        .replace(/(^|[^\w\\_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1*$2*");
}

function line(text) {
    let out = "";
    let at = 0;
    PROTECTED.lastIndex = 0;
    for (let match = PROTECTED.exec(text); match !== null; match = PROTECTED.exec(text)) {
        out += rewrite(text.slice(at, match.index)) + match[0];
        at = match.index + match[0].length;
    }
    return out + rewrite(text.slice(at));
}

/** `markdown` with Qt-dropped emphasis rewritten; code is left byte for byte. */
function normalize(markdown) {
    if (markdown.indexOf("_") < 0 && markdown.indexOf("~") < 0) return markdown;
    const lines = markdown.split("\n");
    let fence = "";
    for (let index = 0; index < lines.length; index += 1) {
        const opener = /^ {0,3}(`{3,}|~{3,})/.exec(lines[index]);
        if (fence !== "") {
            if (opener && opener[1][0] === fence[0] && opener[1].length >= fence.length
                && lines[index].trim() === opener[1]) fence = "";
            continue;
        }
        if (opener) {
            fence = opener[1];
            continue;
        }
        lines[index] = line(lines[index]);
    }
    return lines.join("\n");
}
