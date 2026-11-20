.pragma library

// The launcher's rows: what the HUD opens on, the way the desktop's own menu
// opens on a filter and a list. Pure functions of the query and the listing,
// so the order and the fallbacks are testable without a window.

/** Every HUD section but chat, which a conversation row opens. */
var PLACES = [
    { id: "character", label: "Character", hint: "persona",
        icon: "M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM16 9h3M16 13h3M10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4M6 17a4 4 0 0 1 8 0" },
    { id: "hooks", label: "Hooks", hint: "lifecycle commands",
        icon: "M8 12h8M12 8v8M7 3v4M17 3v4M7 17v4M17 17v4M3 7h4M17 7h4M3 17h4M17 17h4M7 7h10v10H7z" },
    { id: "remote", label: "Remote access", hint: "phone",
        icon: "M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM10 5h4M11 18h2" }
];

/** The stored name, else the first message, else "New conversation". */
function titleOf(session) {
    if (typeof session.title === "string" && session.title !== "") return session.title;
    if (typeof session.preview === "string" && session.preview !== "") return session.preview;
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

/** The preview says something the title does not: neither is the other's start. */
function previewAdds(title, preview) {
    var a = String(title || "").toLowerCase().trim();
    var b = String(preview || "").toLowerCase().trim();
    return b !== "" && b.indexOf(a) !== 0 && a.indexOf(b) !== 0;
}

function contains(text, query) {
    return String(text || "").toLowerCase().indexOf(query) !== -1;
}

/**
 * Conversations in the order a messenger keeps them: pinned, then those where
 * the ghost waits on the owner's answer, then those with an unread reply, then
 * the rest, each newest first. An unread reply stays in
 * view until it is read, however much talk happens elsewhere meanwhile.
 */
function ordered(sessions) {
    // A ghost waiting on the owner's answer outranks an unread reply.
    var rank = function (session) {
        return session.pinned === true ? 0 : session.question ? 1 : session.unread === true ? 2 : 3;
    };
    var time = function (session) {
        return Date.parse(session.updatedAt || "") || 0;
    };
    return (sessions || []).filter(function (session) { return !!session; })
        .sort(function (a, b) { return rank(a) - rank(b) || time(b) - time(a); });
}

/**
 * The rows for `query` over `sessions`, in `ordered` order. Headers are rows too, but never selectable. `hookCount`, the
 * owner's loaded hooks, is the Hooks row's detail when there are any.
 *
 * Empty query: the conversations, then the places. The filter is also where
 * a new conversation starts, so no row repeats it (Ctrl+N opens a blank one).
 * A query: matching conversations and places; asking the ghost is the first
 * row when nothing matches and the last when something does, so Enter opens
 * what was searched for and still asks when there was nothing to find.
 */
function rows(query, sessions, ghost, now, hookCount) {
    var q = String(query || "").trim().toLowerCase();
    var out = [];
    var conversations = [];
    var listed = ordered(sessions);
    var sessionRow = function (session) {
        var title = titleOf(session);
        return {
            kind: "session", id: session.id, label: title,
            title: typeof session.title === "string" ? session.title : "",
            // A question is what the owner most needs to read in the row.
            // At rest a row is its title, as the desktop's menu shows one; a
            // filter brings the preview in to say why it matched. A waiting
            // question is state, so it always shows. A preview that is only
            // the title cut short, or the title's own start, repeats it.
            detail: session.question ? session.question.text
                : q !== "" && previewAdds(title, session.preview) ? session.preview : "",
            asking: !!session.question,
            meta: age(session.updatedAt, now), pinned: session.pinned === true,
            unread: session.unread === true, running: session.running === true
        };
    };
    for (var i = 0; i < listed.length; i++) {
        var session = listed[i];
        if (q !== "" && !contains(titleOf(session), q) && !contains(session.preview, q)
            && !(session.question && contains(session.question.text, q))) continue;
        conversations.push(sessionRow(session));
    }
    var places = [];
    for (var j = 0; j < PLACES.length; j++) {
        var place = PLACES[j];
        if (q !== "" && !contains(place.label, q) && !contains(place.hint, q)) continue;
        // The hooks count is state and always shows; a hint only explains a match.
        var detail = place.id === "hooks" && hookCount > 0 ? hookCount + " loaded" : q !== "" ? place.hint : "";
        places.push({ kind: "place", id: place.id, label: place.label, detail: detail, icon: place.icon });
    }
    var ask = q === "" || ghost === "" ? null
        : { kind: "ask", id: "ask", label: "Ask " + ghost, detail: String(query).trim() };

    if (ask && conversations.length + places.length === 0) out.push(ask);
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
