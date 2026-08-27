.pragma library

// Pure state helpers for the shared Documents browser. The daemon owns path
// confinement and directory snapshots; this file keeps QML's copy-on-write
// maps deterministic so stale XHRs and rebuilt delegates cannot cross paths.

// Presentation limit only: directory listing/deletion still accept arbitrary
// regular files. The separate content route enforces the same limit before the
// read-only inline viewer receives any bytes.
const INLINE_FILE_MAX_BYTES = 1048576;
const PAGE_KEYS = [
    "root", "path", "query", "entries", "total", "fileCount",
    "directoryCount", "nextCursor", "truncated", "skipped"
];
const DIRECTORY_KEYS = ["name", "path", "kind", "modifiedAt"];
const FILE_KEYS = ["name", "path", "kind", "modifiedAt", "size"];
const SKIPPED_KEYS = ["name", "path", "reason"];

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

/** Plain dictionaries must not inherit constructor/toString/__proto__ keys. */
function emptyMap() {
    return Object.create(null);
}

function hasOwn(map, key) {
    return Boolean(map) && Object.prototype.hasOwnProperty.call(map, key);
}

function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected) {
    if (!isObject(value)) return false;
    const keys = Object.keys(value).sort();
    const wanted = expected.slice().sort();
    if (keys.length !== wanted.length) return false;
    for (let index = 0; index < keys.length; index++) {
        if (keys[index] !== wanted[index]) return false;
    }
    return true;
}

function copyMap(source) {
    const next = emptyMap();
    for (const name of Object.keys(source || {})) next[name] = source[name];
    return next;
}

function mapValue(map, name, fallback) {
    return hasOwn(map, name) ? map[name] : fallback;
}

function setMapValue(map, name, value) {
    const next = copyMap(map);
    next[name] = value;
    return next;
}

function isCanonicalPath(value) {
    if (typeof value !== "string" || value.indexOf("\\") >= 0
            || value.indexOf("\0") >= 0 || value.startsWith("/")
            || value.endsWith("/")) return value === "";
    if (value === "") return true;
    return value.split("/").every(function (segment) {
        return segment !== "" && segment !== "." && segment !== "..";
    });
}

/** Invalid input never aliases another Documents path (especially the root). */
function normalizePath(value) {
    return isCanonicalPath(value) ? value : "";
}

function normalizedQuery(value) {
    return text(value).trim().toLocaleLowerCase("en-US");
}

function key(path, query) {
    return JSON.stringify([normalizePath(path), normalizedQuery(query)]);
}

function empty(path, query) {
    return {
        root: "",
        path: normalizePath(path),
        query: normalizedQuery(query),
        entries: [],
        total: 0,
        fileCount: 0,
        directoryCount: 0,
        nextCursor: "",
        truncated: false,
        skipped: [],
        loading: false,
        loaded: false,
        appending: false,
        error: "",
        cursorStale: false
    };
}

function snapshot(cache, path, query) {
    const cacheKey = key(path, query);
    const found = hasOwn(cache, cacheKey) ? cache[cacheKey] : null;
    return found || empty(path, query);
}

function replace(cache, value) {
    const next = copyMap(cache);
    next[key(value.path, value.query)] = value;
    return next;
}

function begin(cache, path, query, append) {
    const current = snapshot(cache, path, query);
    return replace(cache, Object.assign({}, current, {
        loading: true,
        appending: append === true,
        error: "",
        cursorStale: false
    }));
}

function validKind(value) {
    return value === "directory" || value === "file";
}

function validName(value) {
    return typeof value === "string" && value !== "" && value !== "." && value !== ".."
        && value.indexOf("/") < 0 && value.indexOf("\\") < 0 && value.indexOf("\0") < 0;
}

function validTimestamp(value) {
    if (typeof value !== "string"
            || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return false;
    try {
        return new Date(value).toISOString() === value;
    } catch (error) {
        return false;
    }
}

function validAbsolutePath(value) {
    if (typeof value !== "string" || !value.startsWith("/")
            || value.indexOf("\0") >= 0) return false;
    if (value === "/") return true;
    if (value.endsWith("/")) return false;
    return value.slice(1).split("/").every(function (segment) {
        return segment !== "" && segment !== "." && segment !== "..";
    });
}

/** Strict UTF-8 byte length, or -1 for an unpaired UTF-16 surrogate. */
function utf8ByteLength(value) {
    if (typeof value !== "string") return -1;
    let bytes = 0;
    for (let index = 0; index < value.length; index++) {
        const code = value.charCodeAt(index);
        if (code <= 0x7f) bytes += 1;
        else if (code <= 0x7ff) bytes += 2;
        else if (code >= 0xd800 && code <= 0xdbff) {
            if (index + 1 >= value.length) return -1;
            const low = value.charCodeAt(index + 1);
            if (low < 0xdc00 || low > 0xdfff) return -1;
            bytes += 4;
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) return -1;
        else bytes += 3;
    }
    return bytes;
}

function directPath(directory, name) {
    return directory === "" ? name : directory + "/" + name;
}

function validEntry(entry, directory) {
    if (!isObject(entry)
            || !validKind(entry.kind) || !validName(entry.name)
            || !isCanonicalPath(entry.path) || !validTimestamp(entry.modifiedAt)) return false;
    if (entry.path !== directPath(directory, entry.name)) return false;
    if (entry.kind === "directory") return exactKeys(entry, DIRECTORY_KEYS);
    return exactKeys(entry, DIRECTORY_KEYS)
        || (exactKeys(entry, FILE_KEYS)
            && Number.isSafeInteger(entry.size) && entry.size >= 0);
}

function validSkipped(entry, directory) {
    return exactKeys(entry, SKIPPED_KEYS)
        && validName(entry.name) && isCanonicalPath(entry.path)
        && entry.path === directPath(directory, entry.name)
        && typeof entry.reason === "string" && entry.reason !== "";
}

function uniquePaths(entries) {
    const seen = emptyMap();
    for (const entry of entries) {
        if (hasOwn(seen, entry.path)) return false;
        seen[entry.path] = true;
    }
    return true;
}

/** Maximum regular-file size the shell may read into an inline pane. */
function inlineFileMaxBytes() {
    return INLINE_FILE_MAX_BYTES;
}

/** Missing or malformed metadata fails closed even if a caller bypassed applyPage. */
function canReadInline(entry) {
    return entry && entry.kind === "file" && Number.isSafeInteger(entry.size)
        && entry.size >= 0 && entry.size <= INLINE_FILE_MAX_BYTES;
}

function isTooLargeForInline(entry) {
    return entry && entry.kind === "file" && Number.isSafeInteger(entry.size)
        && entry.size > INLINE_FILE_MAX_BYTES;
}

function mergeEntries(current, incoming, append) {
    // Cursor pages are slices of one daemon-owned, globally sorted snapshot.
    // Keep that order byte-for-byte; re-sorting here can disagree on numeric
    // names, locale folding, or case ties and move rows between page appends.
    return append ? (current || []).concat(incoming) : incoming.slice();
}

function applyPage(cache, requestedPath, requestedQuery, body, append) {
    const path = normalizePath(requestedPath);
    const query = normalizedQuery(requestedQuery);
    if (!isCanonicalPath(requestedPath) || !exactKeys(body, PAGE_KEYS)
            || !isCanonicalPath(body.path) || body.path !== path
            || body.query !== query
            || !validAbsolutePath(body.root)
            || !Array.isArray(body.entries) || !Array.isArray(body.skipped)
            || !body.entries.every(function (entry) { return validEntry(entry, path); })
            || !body.skipped.every(function (entry) { return validSkipped(entry, path); })
            || !uniquePaths(body.entries) || !uniquePaths(body.skipped)
            || !Number.isSafeInteger(body.total) || body.total < 0
            || !Number.isSafeInteger(body.fileCount) || body.fileCount < 0
            || !Number.isSafeInteger(body.directoryCount) || body.directoryCount < 0
            || body.total !== body.fileCount + body.directoryCount
            || body.entries.length > body.total
            || (body.nextCursor !== null
                && (typeof body.nextCursor !== "string" || body.nextCursor === ""))
            || typeof body.truncated !== "boolean"
            || body.truncated !== (body.entries.length < body.total)) {
        return { ok: false, cache: fail(cache, path, query,
            "ghostd sent a malformed Documents page", false) };
    }
    const current = snapshot(cache, path, query);
    if (append && (!current.loaded || current.root !== body.root)) {
        return { ok: false, cache: fail(cache, path, query,
            "Documents pagination lost its first page", false) };
    }
    const entries = mergeEntries(current.entries, body.entries, append);
    const loadedFiles = entries.filter(function (entry) { return entry.kind === "file"; }).length;
    const loadedDirectories = entries.length - loadedFiles;
    if (!uniquePaths(entries) || entries.length > body.total || loadedFiles > body.fileCount
            || loadedDirectories > body.directoryCount
            || (body.nextCursor === null && (entries.length !== body.total
                || loadedFiles !== body.fileCount
                || loadedDirectories !== body.directoryCount))) {
        return { ok: false, cache: fail(cache, path, query,
            "ghostd sent an inconsistent Documents page", false) };
    }
    const value = {
        root: body.root,
        path: path,
        query: query,
        entries: entries,
        total: body.total,
        fileCount: body.fileCount,
        directoryCount: body.directoryCount,
        nextCursor: body.nextCursor || "",
        truncated: body.truncated,
        skipped: append
            ? mergeSkipped(current.skipped, body.skipped)
            : body.skipped.slice(),
        loading: false,
        loaded: true,
        appending: false,
        error: "",
        cursorStale: false
    };
    return { ok: true, cache: replace(cache, value), value: value };
}

function mergeSkipped(current, incoming) {
    const byPath = emptyMap();
    for (const item of (current || []).concat(incoming || [])) {
        if (item && text(item.path) !== "") byPath[text(item.path)] = item;
    }
    return Object.keys(byPath).sort().map(function (path) { return byPath[path]; });
}

function fail(cache, path, query, message, cursorStale) {
    const current = snapshot(cache, path, query);
    return replace(cache, Object.assign({}, current, {
        loading: false,
        appending: false,
        error: text(message),
        cursorStale: cursorStale === true
    }));
}

function removePath(cache, removedPath) {
    const path = normalizePath(removedPath);
    const next = emptyMap();
    for (const cacheKey of Object.keys(cache || {})) {
        const current = cache[cacheKey];
        const entries = (current.entries || []).filter(function (entry) {
            return normalizePath(entry.path) !== path;
        });
        const removed = (current.entries || []).length - entries.length;
        next[cacheKey] = removed === 0 ? current : Object.assign({}, current, {
            entries: entries,
            total: Math.max(0, current.total - removed),
            fileCount: Math.max(0, current.fileCount - removed)
        });
    }
    return next;
}

function parent(path) {
    const normalized = normalizePath(path);
    const cut = normalized.lastIndexOf("/");
    return cut < 0 ? "" : normalized.slice(0, cut);
}

function baseName(path) {
    const normalized = normalizePath(path);
    const cut = normalized.lastIndexOf("/");
    return cut < 0 ? normalized : normalized.slice(cut + 1);
}

function breadcrumbs(path) {
    const parts = normalizePath(path).split("/").filter(Boolean);
    const rows = [{ name: "Documents", path: "" }];
    let current = "";
    for (const part of parts) {
        current = current === "" ? part : current + "/" + part;
        rows.push({ name: part, path: current });
    }
    return rows;
}

function visibleFolders(cache, expanded) {
    const rows = [];
    const seen = emptyMap();
    function visit(path, name, depth) {
        if (hasOwn(seen, path)) return;
        seen[path] = true;
        const state = snapshot(cache, path, "");
        const isExpanded = hasOwn(expanded, path) && expanded[path] === true;
        rows.push({
            path: path,
            name: name,
            depth: depth,
            more: false,
            ownerPath: "",
            expanded: isExpanded,
            loading: state.loading,
            loaded: state.loaded,
            error: state.error,
            fileCount: state.fileCount,
            directoryCount: state.directoryCount
        });
        if (!isExpanded || !state.loaded) return;
        for (const entry of state.entries) {
            if (entry.kind === "directory") visit(entry.path, entry.name, depth + 1);
        }
        if (state.nextCursor !== "") {
            rows.push({
                path: path + "\nload-more",
                name: "Load more folders",
                depth: depth + 1,
                more: true,
                ownerPath: path,
                expanded: false,
                loading: state.loading,
                loaded: true,
                error: state.error,
                fileCount: state.fileCount,
                directoryCount: state.directoryCount
            });
        }
    }
    visit("", "Documents", 0);
    return rows;
}

function maxDepth(rows) {
    let deepest = 0;
    for (const row of rows || []) deepest = Math.max(deepest, Number(row.depth) || 0);
    return deepest;
}

function nextFile(entries, removedPath) {
    const files = (entries || []).filter(function (entry) { return entry.kind === "file"; });
    const index = files.findIndex(function (entry) { return entry.path === removedPath; });
    const survivors = files.filter(function (entry) { return entry.path !== removedPath; });
    if (survivors.length === 0) return "";
    return survivors[Math.min(index < 0 ? 0 : index, survivors.length - 1)].path;
}
