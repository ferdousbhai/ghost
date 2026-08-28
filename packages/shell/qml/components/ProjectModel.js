.pragma library

// Pure validation and presentation helpers for the conversation-scoped project
// binding API. Keeping malformed-wire handling here makes the chip and its
// lifecycle client consume exactly the same state vocabulary.

const RESOURCE_KEYS = [
    "instructions",
    "skills",
    "rules",
    "prompts",
    "commands",
    "agents",
    "mcpServers",
    "ignoredExecutable"
];

const STATUSES = ["unbound", "ready", "degraded"];
const MCP_STATUSES = ["off", "ready", "degraded"];
const REASONS = ["default", "legacy", "bound", "reloaded", "unbound", "resumed"];
const STATE_KEYS = [
    "id", "conversationId", "runtime", "root", "cwd", "relativeCwd", "name",
    "generation", "status", "error", "mcpStatus", "resources", "canRebind",
    "lastRefreshAt", "reason"
];
const PREVIEW_KEYS = ["root", "name", "trustToken", "expiresAt", "resources", "warnings"];
const PATH_MAX_BYTES = 16 * 1024;

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

function blankResources() {
    const resources = ({});
    for (const key of RESOURCE_KEYS) resources[key] = 0;
    return resources;
}

function empty() {
    return {
        id: "",
        conversationId: "",
        runtime: "pi",
        root: null,
        cwd: "",
        relativeCwd: null,
        name: null,
        generation: 0,
        status: "unbound",
        error: null,
        mcpStatus: "off",
        resources: blankResources(),
        canRebind: true,
        lastRefreshAt: null,
        reason: "default"
    };
}

function isAbsolute(path) {
    return typeof path === "string" && path.startsWith("/")
        && path.indexOf("\0") < 0;
}

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

function boundedText(value, maximumBytes) {
    const bytes = utf8ByteLength(value);
    return typeof value === "string" && value !== "" && value.indexOf("\0") < 0
        && bytes >= 0 && bytes <= maximumBytes;
}

function isCanonicalAbsolutePath(path) {
    const bytes = utf8ByteLength(path);
    if (!isAbsolute(path) || bytes < 1 || bytes > PATH_MAX_BYTES) return false;
    if (path === "/") return true;
    if (path.endsWith("/")) return false;
    return path.slice(1).split("/").every(function (segment) {
        return segment !== "" && segment !== "." && segment !== "..";
    });
}

function projectName(path) {
    if (path === "/") return "/";
    return path.slice(path.lastIndexOf("/") + 1);
}

function isCount(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function validTimestamp(value) {
    if (typeof value !== "string") return false;
    try {
        return new Date(value).toISOString() === value;
    } catch (error) {
        return false;
    }
}

function resources(value) {
    if (!exactKeys(value, RESOURCE_KEYS)) return null;
    const normalized = ({});
    for (const key of RESOURCE_KEYS) {
        if (!isCount(value[key])) return null;
        normalized[key] = value[key];
    }
    return normalized;
}

function state(value, expectedId) {
    if (!exactKeys(value, STATE_KEYS))
        return { ok: false, error: "missing project state" };
    if (typeof value.id !== "string" || value.id === ""
            || (expectedId && value.id !== expectedId))
        return { ok: false, error: "project identity mismatch" };
    if (typeof value.conversationId !== "string" || value.conversationId === "")
        return { ok: false, error: "missing project conversation identity" };
    if (value.runtime !== "pi" && value.runtime !== "claude-code")
        return { ok: false, error: "invalid project runtime" };
    const prefix = value.runtime + ":";
    if (value.id !== prefix + value.conversationId)
        return { ok: false, error: "project identity mismatch" };
    if (!isCanonicalAbsolutePath(value.cwd))
        return { ok: false, error: "project cwd is not absolute" };
    if (!isCount(value.generation))
        return { ok: false, error: "invalid project generation" };
    if (STATUSES.indexOf(value.status) < 0 || MCP_STATUSES.indexOf(value.mcpStatus) < 0
            || REASONS.indexOf(value.reason) < 0)
        return { ok: false, error: "invalid project status" };
    if (typeof value.canRebind !== "boolean"
            || (value.lastRefreshAt !== null && !validTimestamp(value.lastRefreshAt)))
        return { ok: false, error: "incomplete project state" };
    const counts = resources(value.resources);
    if (!counts) return { ok: false, error: "invalid project resources" };
    if (value.error !== null && (!exactKeys(value.error, ["code", "message"])
            || !boundedText(value.error.code, 128)
            || !boundedText(value.error.message, 8 * 1024)))
        return { ok: false, error: "invalid project error" };

    const bound = value.root !== null;
    if (bound && (!isCanonicalAbsolutePath(value.root) || value.name !== projectName(value.root)
            || typeof value.relativeCwd !== "string"))
        return { ok: false, error: "invalid bound project" };
    if (bound) {
        const expectedRelative = value.cwd === value.root ? "."
            : (value.root === "/" && value.cwd.startsWith("/")
                ? value.cwd.slice(1)
                : (value.cwd.startsWith(value.root + "/")
                    ? value.cwd.slice(value.root.length + 1) : null));
        if (expectedRelative === null || value.relativeCwd !== expectedRelative)
            return { ok: false, error: "project cwd is outside its root" };
    }
    if (!bound && (value.name !== null || value.relativeCwd !== null
            || value.status !== "unbound" || value.error !== null
            || value.mcpStatus !== "off"
            || RESOURCE_KEYS.some(function (key) { return counts[key] !== 0; })))
        return { ok: false, error: "invalid unbound project" };
    return {
        ok: true,
        state: {
            id: value.id,
            conversationId: value.conversationId,
            runtime: value.runtime,
            root: value.root,
            cwd: value.cwd,
            relativeCwd: value.relativeCwd,
            name: value.name,
            generation: value.generation,
            status: value.status,
            error: value.error === null ? null
                : { code: value.error.code, message: value.error.message },
            mcpStatus: value.mcpStatus,
            resources: counts,
            canRebind: value.canRebind,
            lastRefreshAt: value.lastRefreshAt,
            reason: value.reason
        }
    };
}

function preview(value) {
    if (!exactKeys(value, PREVIEW_KEYS)
            || !isCanonicalAbsolutePath(value.root) || value.name !== projectName(value.root)
            || typeof value.trustToken !== "string"
            || value.trustToken === "" || typeof value.expiresAt !== "string"
            || !validTimestamp(value.expiresAt))
        return { ok: false, error: "invalid project preview" };
    const counts = resources(value.resources);
    if (!counts || !Array.isArray(value.warnings)
            || value.warnings.some(function (warning) {
                return typeof warning !== "string";
            }))
        return { ok: false, error: "invalid project preview" };
    return {
        ok: true,
        preview: {
            root: value.root,
            name: value.name,
            trustToken: value.trustToken,
            expiresAt: value.expiresAt,
            resources: counts,
            warnings: value.warnings.slice()
        }
    };
}

function title(value) {
    if (!value || value.root === null) return "Home";
    if (value.name) return value.name;
    return value.root === "/" ? "/" : "Project";
}

function pathLabel(value) {
    if (!value || value.root === null) return "Owner home";
    const relative = value.relativeCwd || "";
    return relative === "" || relative === "." ? "Project root" : relative;
}

function statusLabel(value) {
    if (!value || value.status === "unbound") return "Home";
    return value.status === "degraded" ? "Needs attention" : "Ready";
}

function mcpLabel(value) {
    const status = value && value.mcpStatus ? value.mcpStatus : "off";
    if (status === "ready") return "MCP ready";
    if (status === "degraded") return "MCP degraded";
    return "MCP off";
}

function reasonLabel(value) {
    const reason = value && value.reason ? value.reason : "default";
    if (reason === "legacy") return "Recovered earlier project";
    if (reason === "bound") return "Project selected";
    if (reason === "reloaded") return "Project files reloaded";
    if (reason === "unbound") return "Returned to Home";
    if (reason === "resumed") return "Conversation project restored";
    return "Using Home";
}

function resourceSummary(value) {
    const counts = value && value.resources ? value.resources : blankResources();
    const labels = [
        ["instructions", "instruction"],
        ["skills", "skill"],
        ["rules", "rule"],
        ["prompts", "prompt"],
        ["commands", "command", "commands"],
        ["agents", "agent definition (inactive)", "agent definitions (inactive)"],
        ["mcpServers", "MCP server", "MCP servers"]
    ];
    const parts = [];
    for (const pair of labels) {
        const count = Number(counts[pair[0]] || 0);
        if (count > 0) parts.push(count + " "
            + (count === 1 ? pair[1] : (pair[2] || pair[1] + "s")));
    }
    if (parts.length === 0) return "No project resources discovered";
    return parts.join(" · ");
}

function remember(recent, path, limit) {
    const value = typeof path === "string" ? path.trim() : "";
    if (value === "") return Array.isArray(recent) ? recent.slice() : [];
    const kept = (Array.isArray(recent) ? recent : []).filter(function (item) {
        return item !== value;
    });
    kept.unshift(value);
    return kept.slice(0, Math.max(1, Number(limit || 5)));
}
