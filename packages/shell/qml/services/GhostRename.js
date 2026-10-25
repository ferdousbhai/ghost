.pragma library

// A ghost rename changes several caches at once. Keep the transformation pure
// so an optimistic update has an exact rollback state instead of attempting a
// second, lossy rename when the daemon refuses the request.

function cloneMap(value) {
    return Object.assign({}, value && typeof value === "object" ? value : {});
}

function snapshot(state) {
    var copy = {
        ghosts: Array.isArray(state.ghosts) ? state.ghosts.slice() : [],
        sessionIds: cloneMap(state.sessionIds),
        activeGhost: String(state.activeGhost || "")
    };
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

function move(state, from, to) {
    var next = snapshot(state);
    next.ghosts = renamedGhosts(next.ghosts, from, to);
    next.sessionIds = rekeyMap(next.sessionIds, from, to);
    if (next.activeGhost === from) next.activeGhost = to;
    return next;
}

function prepare(state, from, to) {
    var before = snapshot(state);
    if (!hasGhost(before.ghosts, from))
        return { ok: false, code: "not_found" };
    if (hasGhost(before.ghosts, to))
        return { ok: false, code: "already_exists" };
    return { ok: true, before: before, after: move(before, from, to) };
}
