.pragma library

// Pure helpers for the MCP management surface. The daemon serves the owner
// each server's stored configuration, so editing starts from the real JSON.

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function transport(server) {
    const type = text(server.config.type).toLowerCase();
    return type === "http" || type === "sse" ? type : "stdio";
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

// The server's own configuration in its own transport; a switch to another
// transport starts from that transport's example.
function template(server, type) {
    const config = server && transport(server) === type ? server.config : defaultConfig(type);
    return JSON.stringify(config, null, 2);
}

// Only what the editor itself needs: a JSON object in the selected
// transport. The daemon validates the row and its refusal is shown as is.
function parse(textValue, expectedType) {
    let config;
    try {
        config = JSON.parse(text(textValue));
    } catch (error) {
        return { ok: false, error: "Configuration is not valid JSON: " + error };
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
        return { ok: false, error: "Configuration must be a JSON object." };
    if (expectedType && (config.type === undefined ? "stdio" : config.type) !== expectedType)
        return { ok: false, error: "The JSON type must match the selected transport." };
    return { ok: true, config: config, error: "" };
}

function filtered(servers, query) {
    const needle = text(query).trim().toLowerCase();
    if (needle === "") return servers;
    return servers.filter(function (server) {
        return (server.name + " " + JSON.stringify(server.config)).toLowerCase().indexOf(needle) >= 0;
    });
}

function summary(server) {
    const config = server.config;
    if (transport(server) === "stdio")
        return [text(config.command)].concat(Array.isArray(config.args) ? config.args.map(text) : []).join(" ");
    return text(config.url);
}
