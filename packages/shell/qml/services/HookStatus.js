.pragma library

function normalize(body) {
    if (!body || typeof body !== "object" || !Array.isArray(body.events)
            || !Array.isArray(body.hooks)) return null;
    const events = [];
    for (let index = 0; index < body.events.length; index += 1) {
        const entry = body.events[index];
        if (!entry || typeof entry !== "object" || typeof entry.event !== "string"
                || entry.event.trim() === "" || typeof entry.count !== "number"
                || !isFinite(entry.count) || entry.count < 1) return null;
        events.push({ event: entry.event.trim(), count: Math.floor(entry.count) });
    }
    const total = events.reduce(function (sum, entry) { return sum + entry.count; }, 0);
    const hooks = [];
    for (let index = 0; index < body.hooks.length; index += 1) {
        const hook = body.hooks[index];
        if (!hook || typeof hook !== "object" || typeof hook.event !== "string"
                || hook.event.trim() === "" || typeof hook.name !== "string"
                || hook.name.trim() === "" || typeof hook.description !== "string"
                || hook.description.trim() === "") return null;
        hooks.push({
            event: hook.event.trim(),
            name: hook.name.trim(),
            description: hook.description.trim(),
            idleSeconds: typeof hook.idle_seconds === "number"
                    && isFinite(hook.idle_seconds) && hook.idle_seconds > 0
                ? Math.floor(hook.idle_seconds) : 0
        });
    }
    if (hooks.length !== total) return null;
    const cap = typeof body.session_stop_continuation_cap === "number"
            && isFinite(body.session_stop_continuation_cap)
            && body.session_stop_continuation_cap >= 0
        ? Math.floor(body.session_stop_continuation_cap) : 0;
    return {
        active: total > 0,
        total: total,
        events: events,
        hooks: hooks,
        sessionStopContinuationCap: cap
    };
}

function label(event) {
    if (event === "before_prompt") return "Before prompt";
    if (event === "session_stop") return "Session stop";
    return String(event || "").split("_").map(function (part) {
        return part === "" ? "" : part.charAt(0).toUpperCase() + part.slice(1);
    }).join(" ");
}

function duration(seconds) {
    if (seconds >= 3600 && seconds % 3600 === 0) {
        const hours = seconds / 3600;
        return hours + (hours === 1 ? " hour" : " hours");
    }
    if (seconds >= 60 && seconds % 60 === 0) {
        const minutes = seconds / 60;
        return minutes + (minutes === 1 ? " minute" : " minutes");
    }
    return seconds + (seconds === 1 ? " second" : " seconds");
}

function trigger(event, cap, idleSeconds) {
    if (event === "before_prompt") return "Before each owner prompt";
    if (event === "session_stop") return "After each assistant pass · up to " + cap + " continuations";
    if (event === "conversation_idle") return "After " + duration(idleSeconds || 60)
        + " of conversation inactivity";
    return label(event);
}
