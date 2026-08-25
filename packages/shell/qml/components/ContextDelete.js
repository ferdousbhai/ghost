.pragma library

// Keep destructive targeting and post-delete selection independent from the
// visual delegates. Character and helper rows deliberately yield no target.

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function target(section, row) {
    if ((section !== "docs" && section !== "memory") || !row) return null;
    const path = text(row.path).trim();
    if (path === "") return null;
    const title = section === "docs"
        ? (text(row.title).trim() || text(row.relativePath).trim() || path)
        : (text(row.slug).trim() || text(row.description).trim() || path);
    return { section: section, path: path, title: title };
}

/** Value to select after `deletedPath`, preferring the following row. */
function nextValue(rows, deletedPath, selectionKey) {
    const list = Array.isArray(rows) ? rows : [];
    const survivors = list.filter(function (row) {
        return row && text(row.path) !== deletedPath;
    });
    if (survivors.length === 0) return "";
    let originalIndex = list.findIndex(function (row) {
        return row && text(row.path) === deletedPath;
    });
    if (originalIndex < 0) originalIndex = 0;
    const next = survivors[Math.min(originalIndex, survivors.length - 1)];
    return text(next ? next[selectionKey] : "");
}
