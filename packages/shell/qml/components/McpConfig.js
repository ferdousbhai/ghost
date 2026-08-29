.pragma library

// Pure helpers for the MCP management surface. The daemon's GET response is a
// deliberately lossy view: values that could be credentials never cross HTTP.
// These helpers keep that view presentational and build replacement templates
// only from fields which are safe to round-trip.

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function transport(server) {
    const type = text(server && server.config ? server.config.type : "stdio").toLowerCase();
    return type === "http" || type === "sse" ? type : "stdio";
}

function configuredKeys(value) {
    if (!value || value.configured !== true || !Array.isArray(value.keys)) return [];
    return value.keys.map(text).filter(function (key) { return key !== ""; });
}

function remoteUrlIsRedacted(url) {
    const value = text(url);
    return value.indexOf("?") >= 0 || value.indexOf("[configured]") >= 0
        || value.indexOf("%5Bconfigured%5D") >= 0;
}

function hasHiddenValues(server) {
    const config = server && server.config ? server.config : {};
    return Number(config.argumentCount || 0) > 0
        || configuredKeys(config.environment).length > 0
        || configuredKeys(config.headers).length > 0
        || Boolean(config.auth)
        || Boolean(config.oauth)
        || remoteUrlIsRedacted(config.url);
}

function safeRemoteUrl(value) {
    const url = text(value);
    if (!remoteUrlIsRedacted(url)) return url;
    const query = url.indexOf("?");
    const fragment = url.indexOf("#");
    let cut = url.length;
    if (query >= 0) cut = Math.min(cut, query);
    if (fragment >= 0) cut = Math.min(cut, fragment);
    return url.slice(0, cut);
}

function replacementConfig(server, requestedType) {
    const source = server && server.config ? server.config : {};
    const type = requestedType === "http" || requestedType === "sse"
        ? requestedType : (requestedType === "stdio" ? "stdio" : transport(server));
    const config = { type: type, enabled: !server || server.enabled !== false };
    if (type === "stdio") config.command = transport(server) === "stdio"
        ? text(source.command) : "";
    else config.url = transport(server) === type ? safeRemoteUrl(source.url) : "";
    if (typeof source.timeout === "number") config.timeout = source.timeout;
    if (source.requestIdFormat === "string" || source.requestIdFormat === "number")
        config.requestIdFormat = source.requestIdFormat;
    // These fields are policy/placement metadata, not configured values. The daemon
    // exposes them verbatim in its sanitized view, so replacement
    // editing must carry them forward instead of quietly changing semantics.
    if (type === "stdio") {
        if (typeof source.cwd === "string") config.cwd = source.cwd;
        if (source.envPolicy === "literal") config.envPolicy = source.envPolicy;
    } else if (source.headerPolicy === "origin-locked") {
        config.headerPolicy = source.headerPolicy;
    }
    // Authentication credentials remain hidden and must be re-entered, but
    // their non-secret mechanism is still safe replacement metadata.
    if (source.auth && (source.auth.type === "oauth" || source.auth.type === "apikey"))
        config.auth = { type: source.auth.type };
    return config;
}

function defaultConfig(type) {
    if (type === "http") {
        return {
            type: "http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer REPLACE_ME" }
        };
    }
    if (type === "sse") return { type: "sse", url: "https://example.com/events" };
    return {
        type: "stdio",
        command: "npx",
        args: ["-y", "@example/mcp-server"]
    };
}

function template(server, type) {
    return JSON.stringify(server ? replacementConfig(server, type) : defaultConfig(type), null, 2);
}

function parse(textValue, expectedType) {
    let config;
    try {
        config = JSON.parse(text(textValue));
    } catch (error) {
        return { ok: false, error: "Configuration is not valid JSON: " + error };
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
        return { ok: false, error: "Configuration must be a JSON object." };
    const type = text(config.type || "stdio").toLowerCase();
    if (["stdio", "http", "sse"].indexOf(type) < 0)
        return { ok: false, error: "Type must be stdio, http, or sse." };
    if (expectedType && type !== expectedType)
        return { ok: false, error: "The JSON type must match the selected transport." };
    if (type === "stdio" && text(config.command).trim() === "")
        return { ok: false, error: "A stdio server needs a command." };
    if ((type === "http" || type === "sse") && text(config.url).trim() === "")
        return { ok: false, error: "A remote server needs a URL." };
    const serialized = JSON.stringify(config).toLowerCase();
    if (serialized.indexOf("[configured]") >= 0
            || serialized.indexOf("%5bconfigured%5d") >= 0)
        return {
            ok: false,
            error: "Replace every [configured] marker with the real value before saving."
        };
    config.type = type;
    return { ok: true, config: config, error: "" };
}

function searchableText(server) {
    const config = server && server.config ? server.config : {};
    return [
        text(server ? server.name : ""),
        transport(server),
        text(server ? server.source : ""),
        text(config.command),
        text(config.url),
        text(config.cwd),
        text(config.envPolicy),
        text(config.headerPolicy),
        text(config.auth ? config.auth.type : ""),
        configuredKeys(config.environment).join(" "),
        configuredKeys(config.headers).join(" ")
    ].join(" ").toLowerCase();
}

function filtered(servers, query) {
    const list = Array.isArray(servers) ? servers : [];
    const needle = text(query).trim().toLowerCase();
    if (needle === "") return list;
    return list.filter(function (server) {
        return searchableText(server).indexOf(needle) >= 0;
    });
}

function summary(server) {
    const config = server && server.config ? server.config : {};
    if (transport(server) === "stdio") {
        const count = Number(config.argumentCount || 0);
        return text(config.command) + (count > 0 ? " · " + count + " hidden argument"
            + (count === 1 ? "" : "s") : "");
    }
    return text(config.url);
}
