.pragma library

function subscriptionLabel(model) {
    if (!model || model.provider !== "claude-code"
            || typeof model.subscriptionType !== "string") return "";
    const type = model.subscriptionType.trim();
    if (type === "") return "";
    const displayType = type.charAt(0).toUpperCase() + type.slice(1);
    return "Claude " + displayType + " subscription";
}

function connectionLabel(model) {
    const subscription = subscriptionLabel(model);
    if (subscription !== "") return subscription;
    return model && model.connectedVia ? "via " + model.connectedVia : "";
}
