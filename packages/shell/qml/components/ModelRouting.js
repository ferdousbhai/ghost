.pragma library

// Pure shaping for the advanced OMP role picker. The daemon owns role
// semantics and validation; these helpers group its rows and construct one
// complete fallback replacement for every remove/reorder gesture.

const GROUPS = [
    {
        label: "Conversation",
        roles: ["chat_model", "vision_model"]
    },
    {
        label: "Everyday work",
        roles: ["smol_model", "slow_model", "plan_model", "designer_model"]
    },
    {
        label: "Automation",
        roles: ["commit_model", "tiny_model", "task_model", "advisor_model"]
    },
    {
        label: "Compatibility",
        roles: ["general_purpose_model", "research_model"]
    }
];

function text(value) {
    return value === undefined || value === null ? "" : String(value);
}

function rows(routes) {
    const source = Array.isArray(routes) ? routes : [];
    const byRole = {};
    for (const route of source) {
        const role = text(route ? route.role : "");
        if (role !== "") byRole[role] = route;
    }

    const result = [];
    const included = {};
    for (const group of GROUPS) {
        const members = [];
        for (const role of group.roles) {
            if (byRole[role]) {
                members.push(byRole[role]);
                included[role] = true;
            }
        }
        if (members.length === 0) continue;
        result.push({ header: true, label: group.label, route: null });
        for (const route of members) result.push({ header: false, label: "", route: route });
    }
    const remaining = source.filter(function (route) {
        return route && !included[text(route.role)];
    });
    if (remaining.length > 0) {
        result.push({ header: true, label: "Other", route: null });
        for (const route of remaining) result.push({ header: false, label: "", route: route });
    }
    return result;
}

function modelName(model) {
    if (!model) return "unavailable";
    const provider = text(model.provider);
    const id = text(model.id);
    if (provider === "") return id || "unavailable";
    return id === "" ? provider : provider + "/" + id;
}

function sourceLine(route) {
    const source = text(route ? route.source : "unavailable");
    if (source === "explicit") return "Explicit · " + modelName(route.primary);
    if (source === "auto") return "Auto → " + modelName(route.effective);
    return "Auto → unavailable";
}

function selections(chain) {
    if (!Array.isArray(chain)) return [];
    return chain.map(function (model) {
        return { provider: text(model ? model.provider : ""), id: text(model ? model.id : "") };
    }).filter(function (model) {
        return model.provider !== "" && model.id !== "";
    });
}

function removeFallback(chain, index) {
    const result = selections(chain);
    if (index >= 0 && index < result.length) result.splice(index, 1);
    return result;
}

function moveFallback(chain, index, delta) {
    const result = selections(chain);
    const destination = index + delta;
    if (index < 0 || index >= result.length || destination < 0 || destination >= result.length)
        return result;
    const moved = result[index];
    result[index] = result[destination];
    result[destination] = moved;
    return result;
}
