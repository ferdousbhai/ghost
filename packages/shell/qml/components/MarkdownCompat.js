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
// bare URLs.
//
// Links are painted in the application palette's link colour, a fixed blue,
// whatever `linkColor` or the item's palette says; inline HTML anchors honour
// their own style. So `[label](url)`, `<url>`, and bare URLs become
// `<a style>` with the label converted to HTML, since markdown inside raw HTML
// is not parsed. When Qt formats these again, this file is deleted.

// Spans whose bytes must reach Qt untouched or as a link, in the order they
// win: code span, image, inline link, autolink, HTML tag, bare URL.
const PROTECTED = /(`+)[^`]*?\1|!\[[^\]\n]*\]\([^)\n]*\)|\[((?:\\.|[^\[\]\n])+)\]\(([^()\s]+)(?:\s+"[^"\n]*")?\)|<(https?:\/\/[^\s<>]+)>|<[^<>\n]+>|https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*~]/g;

function escaped(text) {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** A link label's markdown as HTML: code, strong, emphasis, strike. */
function labelHtml(label) {
    const parts = label.split(/(`+[^`]*?`+)/);
    return parts.map((part, index) => index % 2 === 1
        ? "<code>" + escaped(part.replace(/^`+|`+$/g, "")) + "</code>"
        : escaped(part.replace(/\\([^\w\s])/g, "$1"))
            .replace(/(\*\*|__)(?=\S)(.*?\S)\1/g, "<b>$2</b>")
            .replace(/(\*|\b_)(?=\S)(.*?\S)(\*|_\b)/g, "<i>$2</i>")
            .replace(/~~?(?=\S)(.*?\S)~~?/g, "<del>$1</del>")).join("");
}

function anchor(url, labelHtmlText, linkColor) {
    return '<a href="' + escaped(url) + '" style="color:' + linkColor + '; text-decoration:none">'
        + labelHtmlText + "</a>";
}

function rewrite(plain) {
    return plain
        .replace(/(^|[^\w\\~])~~(?=\S)([^~\n]*?\S)~~(?![\w~])/g, "$1<del>$2</del>")
        .replace(/(^|[^\w\\~])~(?=\S)([^~\n]*?\S)~(?![\w~])/g, "$1<del>$2</del>")
        .replace(/(^|[^\w\\_])__(?=\S)([^\n]*?\S)__(?![\w_])/g, "$1**$2**")
        .replace(/(^|[^\w\\_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, "$1*$2*");
}

function protectedSpan(match, linkColor) {
    if (match[3] !== undefined) return anchor(match[3], labelHtml(match[2]), linkColor);
    if (match[4] !== undefined) return anchor(match[4], escaped(match[4]), linkColor);
    if (/^https?:/.test(match[0])) return anchor(match[0], escaped(match[0]), linkColor);
    return match[0];
}

function line(text, linkColor) {
    let out = "";
    let at = 0;
    PROTECTED.lastIndex = 0;
    for (let match = PROTECTED.exec(text); match !== null; match = PROTECTED.exec(text)) {
        out += rewrite(text.slice(at, match.index)) + protectedSpan(match, linkColor);
        at = match.index + match[0].length;
    }
    return out + rewrite(text.slice(at));
}

/**
 * `markdown` with Qt-dropped emphasis rewritten and links drawn in
 * `linkColor`; code is left byte for byte.
 */
function normalize(markdown, linkColor) {
    if (!/[_~[]|https?:/.test(markdown)) return markdown;
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
        lines[index] = line(lines[index], linkColor);
    }
    return lines.join("\n");
}
