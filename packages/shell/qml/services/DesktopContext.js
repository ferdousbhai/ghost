.pragma library
.import "DesktopKeys.js" as Desk

// DesktopContext — what a summon came from. Presence records the focused
// window as the summon arrives, before its prompt takes the focus, and sends
// it with that summon's prompt as the daemon's `desktop` field (CONTRACTS.md,
// "Daemon HTTP API"): the app, the title, and a focused terminal's directory.
// Nothing else on screen is read: no selection, clipboard, or pixels.

/** The daemon's bounds on each field, so a long title is cut, not refused. */
var LIMITS = { app: 256, title: 1024, cwd: 4096 };

/**
 * A terminal's shell directory by window address, the way Omarchy's
 * omarchy-cmd-terminal-cwd finds it for the active window: that window's
 * youngest child, if it runs a login shell. The address pins the window, so
 * the prompt taking focus meanwhile changes nothing.
 */
var CWD_SCRIPT = "pid=$(hyprctl clients -j | jq -r --arg a \"$1\" "
    + "'.[] | select((.address | ltrimstr(\"0x\")) == ($a | ltrimstr(\"0x\"))) | .pid') || exit 0; "
    + "[ -n \"$pid\" ] || exit 0; "
    + "shell=$(pgrep -P \"$pid\" | tail -n1); [ -n \"$shell\" ] || exit 0; "
    + "exe=$(readlink -f \"/proc/$shell/exe\"); grep -Fqsx \"$exe\" /etc/shells || exit 0; "
    + "readlink -f \"/proc/$shell/cwd\"";

/** The focused window as a summon finds it, or null for none or Ghost's own. */
function capture(toplevel) {
    if (!toplevel) return null;
    var title = String(toplevel.title || "");
    if (title === Desk.HUD_TITLE || title === Desk.PROMPT_TITLE) return null;
    var app = toplevel.wayland ? String(toplevel.wayland.appId || "") : "";
    if (app === "" && title === "") return null;
    return { app: app, title: title, address: String(toplevel.address || "") };
}

function cwdCommand(address) {
    return ["bash", "-c", CWD_SCRIPT, "ghost-cwd", address];
}

/** The wire's `desktop`, within the daemon's bounds; null when nothing was captured. */
function payload(captured, cwd) {
    if (!captured) return null;
    var out = {};
    if (captured.app) out.app = captured.app.slice(0, LIMITS.app);
    if (captured.title) out.title = captured.title.slice(0, LIMITS.title);
    var dir = String(cwd || "").trim();
    if (dir !== "") out.cwd = dir.slice(0, LIMITS.cwd);
    return Object.keys(out).length > 0 ? out : null;
}
