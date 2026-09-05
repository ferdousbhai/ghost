.pragma library

// A ghost rename changes several caches at once. Keep the transformation pure
// so an optimistic update has an exact rollback state instead of attempting a
// second, lossy rename when the daemon refuses the request.

var ownerKeys = [
    "greetingGhost",
    "loginGhost",
    "commandsGhost",
    "delegatedTasksGhost",
    "mcpGhost",
    "activeGhost",
    "memoryGhost",
    "characterGhost"
];

function cloneMap(value) {
    return Object.assign({}, value && typeof value === "object" ? value : {});
}

function snapshot(state) {
    var copy = {
        ghosts: Array.isArray(state.ghosts) ? state.ghosts.slice() : [],
        sessionIds: cloneMap(state.sessionIds),
        commandExchanges: cloneMap(state.commandExchanges),
        commandTurnKey: String(state.commandTurnKey || "")
    };
    for (var key of ownerKeys) copy[key] = String(state[key] || "");
    return copy;
}

function hasGhost(ghosts, name) {
    return Array.isArray(ghosts) && ghosts.some(function (ghost) {
        return ghost && ghost.name === name;
    });
}

function renamedGhosts(ghosts, from, to) {
    return ghosts.map(function (ghost) {
        if (!ghost || ghost.name !== from) return ghost;
        var dir = String(ghost.dir || "");
        var cut = dir.lastIndexOf("/");
        return Object.assign({}, ghost, {
            name: to,
            dir: cut >= 0 ? dir.slice(0, cut + 1) + to : dir
        });
    });
}

function rekeyMap(value, from, to) {
    var next = cloneMap(value);
    if (from in next) {
        next[to] = next[from];
        delete next[from];
    }
    return next;
}

function rekeyCommandExchanges(value, from, to) {
    var prefix = from + "\n";
    var next = {};
    for (var key of Object.keys(value || {})) {
        var moved = key.startsWith(prefix) ? to + key.slice(from.length) : key;
        next[moved] = value[key];
    }
    return next;
}

function move(state, from, to) {
    var next = snapshot(state);
    next.ghosts = renamedGhosts(next.ghosts, from, to);
    next.sessionIds = rekeyMap(next.sessionIds, from, to);
    next.commandExchanges = rekeyCommandExchanges(next.commandExchanges, from, to);
    var commandPrefix = from + "\n";
    if (next.commandTurnKey.startsWith(commandPrefix))
        next.commandTurnKey = to + next.commandTurnKey.slice(from.length);
    for (var key of ownerKeys) {
        if (next[key] === from) next[key] = to;
    }
    return next;
}

function prepare(state, from, to) {
    var before = snapshot(state);
    if (!hasGhost(before.ghosts, from))
        return { ok: false, code: "not_found", before: before };
    if (hasGhost(before.ghosts, to))
        return { ok: false, code: "already_exists", before: before };
    return { ok: true, before: before, after: move(before, from, to) };
}

function rollback(transaction) {
    return snapshot(transaction.before);
}
