.pragma library

/** Route one validated helper intent through the shell's existing owners. */
function dispatch(message, ghostd, hud, quit) {
    if (!message || typeof message.action !== "string") return false;
    switch (message.action) {
    case "toggle":
        hud.toggle();
        return true;
    case "ghost":
        if (message.name) ghostd.selectGhost(message.name);
        hud.open();
        return true;
    case "conversation":
        if (message.name && message.sessionId)
            ghostd.openConversationForGhost(message.name, message.sessionId);
        hud.open();
        return true;
    case "new":
        if (message.name) ghostd.newConversationForGhost(message.name);
        else ghostd.newConversation();
        hud.open();
        return true;
    case "switcher":
        hud.open();
        hud.openSwitcher();
        return true;
    case "login":
        hud.open();
        hud.openLogin();
        return true;
    case "quit":
        quit();
        return true;
    }
    return false;
}
