.pragma library

// The launcher's rows: what the HUD opens on, the way the desktop's own menu
// opens on a filter and a list. Pure functions of the query and the listing,
// so the order and the fallbacks are testable without a window.

/** Every HUD section but chat, which a conversation row opens. */
var PLACES = [
    { id: "board", label: "Board", hint: "board.md",
        icon: "M9 6h12M9 12h12M9 18h12M3 6l1.5 1.5L7 5M3 12l1.5 1.5L7 11M3 18l1.5 1.5L7 17" },
    { id: "routines", label: "Routines", hint: "timers",
        icon: "M12 8v4l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0" },
    { id: "character", label: "Character", hint: "persona",
        icon: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 9h3M16 13h3M10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 17a4 4 0 0 1 8 0" },
    { id: "ghosts", label: "Ghosts", hint: "switch, summon, rename",
        icon: "M12 2a8 8 0 0 0-8 8v12l3-3 2.5 2.5L12 19l2.5 2.5L17 19l3 3V10a8 8 0 0 0-8-8zM9 10h.01M15 10h.01" },
    { id: "hooks", label: "Hooks", hint: "lifecycle commands",
        icon: "M8 12h8M12 8v8M7 3v4M17 3v4M7 17v4M17 17v4M3 7h4M17 7h4M3 17h4M17 17h4M7 7h10v10H7z" },
    { id: "mcp", label: "MCP servers", hint: "tools",
        icon: "M12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM5 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM12 7v5M7.5 17.5l3-5M16.5 17.5l-3-5" },
    { id: "remote", label: "Remote access", hint: "phone",
        icon: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 5h4M11 18h2" }
];

/** The stored name, else the first message, else "New conversation". */
function titleOf(session) {
    if (session && typeof session.title === "string" && session.title !== "") return session.title;
    if (session && typeof session.preview === "string" && session.preview !== "") return session.preview;
    return "New conversation";
}

/** "now", "5m", "3h", "Tue", "12 Oct": as much date as the distance needs. */
function age(updatedAt, now) {
    var then = Date.parse(updatedAt || "");
    if (!then) return "";
    var seconds = Math.max(0, (now - then) / 1000);
    if (seconds < 60) return "now";
    if (seconds < 3600) return Math.floor(seconds / 60) + "m";
    if (seconds < 86400) return Math.floor(seconds / 3600) + "h";
    var date = new Date(then);
    if (seconds < 6 * 86400) return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][date.getDay()];
    return date.getDate() + " " + ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep",
        "Oct", "Nov", "Dec"][date.getMonth()];
}

function contains(text, query) {
    return String(text || "").toLowerCase().indexOf(query) !== -1;
}

/**
 * The rows for `query` over `sessions` (Ghostd's ordered listing: pinned,
 * then newest). Headers are rows too, but never selectable. `hookCount`, the
 * owner's loaded hooks, is the Hooks row's detail when there are any.
 *
 * Empty query: a new conversation, the conversations, then the places.
 * A query: matching conversations and places; asking the ghost is the first
 * row when nothing matches and the last when something does, so Enter opens
 * what was searched for and still asks when there was nothing to find.
 */
function rows(query, sessions, ghost, now, hookCount) {
    var q = String(query || "").trim().toLowerCase();
    var out = [];
    var conversations = [];
    for (var i = 0; i < (sessions || []).length; i++) {
        var session = sessions[i];
        if (!session) continue;
        var title = titleOf(session);
        if (q !== "" && !contains(title, q) && !contains(session.preview, q)) continue;
        conversations.push({
            kind: "session", id: session.id, label: title,
            title: typeof session.title === "string" ? session.title : "",
            detail: session.title && session.preview && session.preview !== title ? session.preview : "",
            meta: age(session.updatedAt, now), pinned: session.pinned === true,
            unread: session.unread === true, running: session.running === true
        });
    }
    var places = [];
    for (var j = 0; j < PLACES.length; j++) {
        var place = PLACES[j];
        if (q !== "" && !contains(place.label, q) && !contains(place.hint, q)) continue;
        var detail = place.id === "hooks" && hookCount > 0 ? hookCount + " loaded" : place.hint;
        places.push({ kind: "place", id: place.id, label: place.label, detail: detail, icon: place.icon });
    }
    var ask = q === "" || ghost === "" ? null
        : { kind: "ask", id: "ask", label: "Ask " + ghost, detail: String(query).trim() };

    if (q === "") out.push({ kind: "new", id: "new", label: "New conversation", detail: "Ctrl+N" });
    else if (ask && conversations.length + places.length === 0) out.push(ask);
    if (conversations.length > 0) {
        out.push({ kind: "header", id: "h-conversations", label: "Conversations" });
        out = out.concat(conversations);
    }
    if (places.length > 0) {
        out.push({ kind: "header", id: "h-places", label: ghost === "" ? "Ghost" : ghost });
        out = out.concat(places);
    }
    if (ask && conversations.length + places.length > 0) {
        out.push({ kind: "header", id: "h-ask", label: "Ask" });
        out.push(ask);
    }
    return out;
}

/** The next selectable row from `index` in `step` direction, or `index` at the end. */
function step(list, index, direction) {
    for (var i = index + direction; i >= 0 && i < list.length; i += direction) {
        if (list[i].kind !== "header") return i;
    }
    return index;
}

/** The first selectable row, or -1. */
function first(list) {
    for (var i = 0; i < list.length; i++) if (list[i].kind !== "header") return i;
    return -1;
}
