.pragma library

// The decisions behind an in-place memory edit, kept pure so a test can pin
// them. A row is one plain fact — the file's whole content — so "changed" is a
// trimmed string comparison and nothing more.

/** The unsaved new row: no file yet, so no slug and no path below memory/. */
var DRAFT = { path: "memory/", slug: "", content: "", updated: "" };

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

/**
 * Whether ending an edit should write `buffer` over `original`. An emptied
 * row is never written: the writer would refuse it, and the way to remove a
 * fact is the row's × — so an emptied draft simply vanishes and an emptied
 * existing fact keeps what it had.
 */
function shouldWrite(original, buffer) {
    var next = text(buffer).trim();
    return next !== "" && next !== text(original).trim();
}

/** "Aug 21", or "Aug 21, 2025" once it is no longer this year; "" if unparsable. */
function dayLabel(iso, now) {
    var value = text(iso);
    if (value === "") return "";
    var date = new Date(value);
    if (isNaN(date.getTime())) return "";
    return Qt.formatDate(date, date.getFullYear() === now.getFullYear() ? "MMM d" : "MMM d, yyyy");
}
