.import "Plugin.js" as Plugin

// A notification shows plain text, so markdown keeps its words and loses its
// syntax: emphasis, code marks, headings, list and quote markers, and links.
function plain(text) {
    return String(text || "")
        .replace(/^\s*(```|~~~).*$/gmu, "")
        .replace(/!\[([^\]]*)\]\([^)]*\)/gu, "$1")
        .replace(/\[([^\]]+)\]\([^)]*\)/gu, "$1")
        .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+(\[[ xX]\]\s+)?|\d+[.)]\s+)/gmu, "")
        .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/gu, "$2")
        .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?![\w*])/gu, "$1$2")
        .replace(/`+([^`]*)`+/gu, "$1");
}

function excerpt(text, limit) {
    const flat = plain(text).replace(/\s+/gu, " ").trim();
    return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

function command(ghost, sessionId, title, body, urgency, replaceId) {
    const payload = JSON.stringify({ ghost: ghost, sessionId: sessionId, section: "chat" });
    const action = ["omarchy-shell", "shell", "summon", Plugin.ID, payload];
    return [
        "notify-send",
        "--app-name=ghost",
        "--print-id",
        "--replace-id=" + (replaceId || 0),
        "--urgency=" + urgency,
        "--hint=string:omarchy-exec-argv:" + JSON.stringify(action),
        "--",
        ghost + " · " + excerpt(title || "Conversation", 80),
        excerpt(body, 180)
    ];
}
