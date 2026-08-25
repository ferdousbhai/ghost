.pragma library

// Normalise the deliberately small but evolving live/collaboration response
// shapes for the QML surface. No helper logs or serialises URLs.

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function firstText(values) {
    for (const value of values) {
        const candidate = text(value).trim();
        if (candidate !== "") return candidate;
    }
    return "";
}

function phase(status) {
    if (!status || typeof status !== "object") return "idle";
    return firstText([status.phase, status.status, status.state]) || "idle";
}

function phaseLabel(status) {
    const value = phase(status).replace(/[_-]+/gu, " ");
    return value.charAt(0).toUpperCase() + value.slice(1);
}

function liveActive(status) {
    if (status && status.active === true) return true;
    if (status && status.active === false) return false;
    const value = phase(status).toLowerCase();
    return ["idle", "stopped", "offline", "not supported", "unsupported", "unavailable"]
        .indexOf(value) < 0;
}

function muted(status) {
    return Boolean(status && (status.muted === true || phase(status).toLowerCase() === "muted"));
}

function level(status) {
    if (!status || typeof status !== "object") return 0;
    const value = Number(status.inputLevel ?? status.level ?? status.audioLevel ?? 0);
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(1, value));
}

function transcript(status) {
    if (!status || typeof status !== "object") return "";
    if (typeof status.transcript === "string") return status.transcript.trim();
    if (!Array.isArray(status.transcript)) return "";
    return status.transcript.map(function (entry) {
        if (typeof entry === "string") return entry;
        if (!entry || typeof entry !== "object") return "";
        const speaker = firstText([entry.speaker, entry.role]);
        const body = firstText([entry.text, entry.content]);
        return speaker !== "" && body !== "" ? speaker + ": " + body : body;
    }).filter(function (entry) { return entry !== ""; }).join("\n");
}

function notSupported(status) {
    if (!status || typeof status !== "object") return false;
    return status.supported === false || status.code === "not_supported"
        || status.errorCode === "not_supported"
        || Boolean(status.error && status.error.code === "not_supported");
}

function supportMessage(status, fallback) {
    if (!status || typeof status !== "object") return fallback || "Not supported.";
    return firstText([
        status.message,
        status.reason,
        status.error && status.error.message,
        fallback
    ]);
}

function collabActive(status) {
    if (!status || typeof status !== "object" || notSupported(status)) return false;
    if (status.active === true) return true;
    if (readOnlyUrl(status) !== "" || writableUrl(status) !== "") return true;
    const value = phase(status).toLowerCase();
    return ["active", "connected", "running", "sharing"].indexOf(value) >= 0;
}

function readOnlyUrl(status) {
    const urls = status && status.urls && typeof status.urls === "object" ? status.urls : {};
    return firstText([
        status ? status.readOnlyUrl : "",
        status ? status.readonlyUrl : "",
        status ? status.readUrl : "",
        urls.readOnly,
        urls.readonly,
        urls.read
    ]);
}

function writableUrl(status) {
    const urls = status && status.urls && typeof status.urls === "object" ? status.urls : {};
    return firstText([
        status ? status.writableUrl : "",
        status ? status.writeUrl : "",
        urls.writable,
        urls.write
    ]);
}

