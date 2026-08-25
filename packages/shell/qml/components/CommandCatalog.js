.pragma library

// Pure command-catalog shaping shared by the full Commands page and the
// composer's compact slash completion. The daemon owns discovery and
// precedence; this file only makes its effective list pleasant to browse.

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function commandName(command) {
    let name = text(command ? command.name : "").trim();
    while (name.startsWith("/")) name = name.slice(1);
    return name;
}

function aliases(command) {
    if (!command || !Array.isArray(command.aliases)) return [];
    const result = [];
    for (const value of command.aliases) {
        let alias = text(value).trim();
        while (alias.startsWith("/")) alias = alias.slice(1);
        if (alias !== "" && result.indexOf(alias) < 0) result.push(alias);
    }
    return result;
}

function sourceName(command) {
    const source = text(command ? command.source : "").trim();
    return source === "" ? "session" : source;
}

function sourceLabel(source) {
    const raw = text(source).trim();
    if (raw === "") return "Session";
    const words = raw.replace(/[_-]+/gu, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function inputHint(input) {
    if (typeof input === "string") return input.trim();
    if (!input || typeof input !== "object") return "";
    for (const key of ["usage", "placeholder", "hint", "description"]) {
        const value = text(input[key]).trim();
        if (value !== "") return value;
    }
    return "";
}

function subcommandText(command) {
    if (!command || !Array.isArray(command.subcommands)) return "";
    const names = [];
    for (const subcommand of command.subcommands) {
        const value = typeof subcommand === "string"
            ? subcommand : text(subcommand ? subcommand.name : "");
        const name = value.trim().replace(/^\/+/, "");
        if (name !== "" && names.indexOf(name) < 0) names.push(name);
    }
    return names.join("  ·  ");
}

function invocation(command) {
    const name = commandName(command);
    return name === "" ? "" : "/" + name + " ";
}

function availability(command) {
    const value = text(command ? command.availability : "").trim().toLowerCase();
    return value === "partial" || value === "unsupported" ? value : "supported";
}

function availabilityLabel(command) {
    const value = availability(command);
    if (value === "unsupported") return "Unsupported here";
    if (value === "partial") return "Partial support";
    return "";
}

function unavailableReason(command) {
    return text(command ? command.unavailableReason : "").trim();
}

function searchableText(command) {
    return [
        commandName(command),
        aliases(command).join(" "),
        text(command ? command.description : ""),
        sourceName(command),
        availabilityLabel(command),
        unavailableReason(command),
        inputHint(command ? command.input : null),
        subcommandText(command)
    ].join(" ").toLowerCase();
}

function filtered(commands, query) {
    if (!Array.isArray(commands)) return [];
    const needle = text(query).trim().toLowerCase();
    return commands.filter(function (command) {
        return commandName(command) !== ""
            && (needle === "" || searchableText(command).indexOf(needle) >= 0);
    });
}

function groups(commands, query) {
    const result = [];
    const bySource = ({});
    for (const command of filtered(commands, query)) {
        const source = sourceName(command);
        if (!(source in bySource)) {
            const group = { source: source, label: sourceLabel(source), commands: [] };
            bySource[source] = group;
            result.push(group);
        }
        bySource[source].commands.push(command);
    }
    return result;
}

function completions(commands, token, limit) {
    let needle = text(token).trim().toLowerCase();
    while (needle.startsWith("/")) needle = needle.slice(1);
    const matches = filtered(commands, "").filter(function (command) {
        if (needle === "") return true;
        if (commandName(command).toLowerCase().startsWith(needle)) return true;
        return aliases(command).some(function (alias) {
            return alias.toLowerCase().startsWith(needle);
        });
    });
    const cap = Number(limit) > 0 ? Number(limit) : matches.length;
    return matches.slice(0, cap);
}
