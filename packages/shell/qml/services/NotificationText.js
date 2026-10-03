function excerpt(text, limit) {
    const flat = String(text || "").replace(/\s+/gu, " ").trim();
    return flat.length > limit ? flat.slice(0, limit - 1) + "…" : flat;
}

function command(ghost, sessionId, title, body, urgency, replaceId) {
    const payload = JSON.stringify({ ghost: ghost, sessionId: sessionId, section: "chat" });
    const action = ["omarchy-shell", "shell", "summon", "ferdousbhai.ghost", payload];
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
