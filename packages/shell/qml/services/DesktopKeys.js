.pragma library

// What DesktopKeys.qml asks Hyprland for, as Lua for `hyprctl eval` and
// dispatcher expressions, plus the reading of `hyprctl binds -j` that decides
// whether the summon key is free. Pure, so the decisions are testable.

var SUMMON_KEYS = "SUPER + CTRL + G";
var SUMMON_MODMASK = 64 | 4; // SUPER | CTRL
/** The contrib snippet's description: the owner's own bind for Ghost. */
var OWNER_DESCRIPTION = "Summon ghost";
/** The shell's claim of a free key, which it alone takes back. */
var SHELL_DESCRIPTION = "Summon ghost (shell)";
var RULE_NAME = "ghost-windows";

/**
 * The titles of Ghost's two keyboard windows, the HUD and the presence prompt.
 * A plugin's windows carry the host shell's app-id, so the title is what the
 * window rules and focus requests find them by.
 */
var HUD_TITLE = "Ghost";
var PROMPT_TITLE = "Ghost prompt";
var HOST_CLASS = "^org\\.quickshell$";

function command(pluginId, verb) {
    return "omarchy-shell shell " + verb + " " + pluginId;
}

/**
 * Who holds the summon key: "free"; "shell" (an earlier claim by this plugin,
 * which a new one takes over); "owner" (the owner bound it to this plugin
 * themselves); or "taken" (by something else). The last two are left alone.
 * A bind made from Lua lists a function number as its argument, so a claim
 * is known by its description.
 */
function summonKeyState(binds, pluginId) {
    var list = Array.isArray(binds) ? binds : [];
    for (var i = 0; i < list.length; i++) {
        var bind = list[i] || {};
        if ((bind.submap || "") !== "") continue;
        if (bind.modmask !== SUMMON_MODMASK || String(bind.key || "").toLowerCase() !== "g") continue;
        if (bind.description === SHELL_DESCRIPTION) return "shell";
        var owner = String(bind.arg || "").indexOf(pluginId) >= 0 || bind.description === OWNER_DESCRIPTION;
        return owner ? "owner" : "taken";
    }
    return "free";
}

function luaString(text) {
    return JSON.stringify(String(text));
}

function escaped(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A title as a whole-string pattern for a window rule or focus request. */
function titlePattern(title) {
    return "^" + escaped(title) + "$";
}

function ruleLua(enabled) {
    var match = "match = { class = " + luaString(HOST_CLASS)
        + ", title = " + luaString("^(" + [HUD_TITLE, PROMPT_TITLE].map(escaped).join("|") + ")$") + " }";
    if (!enabled) return "hl.window_rule({ name = " + luaString(RULE_NAME) + ", enabled = false, " + match + " })";
    return "hl.window_rule({ name = " + luaString(RULE_NAME) + ", " + match + ", float = true, pin = true,"
        + " size = { \"monitor_w\", \"monitor_h\" }, move = { 0, 0 },"
        + " border_size = 0, rounding = 0, no_shadow = true, no_anim = true,"
        + " opacity = \"1 1\", tag = \"-default-opacity\" })";
}

/**
 * How Hyprland keeps Ghost's keyboard windows: floating over the tiling, the
 * size of their monitor from its corner, pinned across workspaces, with no
 * border, rounding, shadow or open animation of their own (they draw their own
 * scrim and card, and animate them), and out of Omarchy's default inactive
 * opacity. Named, so a re-run replaces rather than adds.
 *
 * `token` marks this shell as the one that last set Ghost up, in a Lua global
 * the compositor keeps until its next config reload. A shell's withdrawal only
 * acts while its token is current, so an old shell going away after a new one
 * has loaded (a plugin reload) cannot take the new one's key and rules.
 */
function setUpLua(token) {
    return "ghost_shell = " + luaString(token) + "; " + ruleLua(true);
}

/** Claim the free summon key, replacing an earlier claim by this plugin. */
function summonBindLua(pluginId) {
    return "hl.unbind(" + luaString(SUMMON_KEYS) + "); hl.bind(" + luaString(SUMMON_KEYS)
        + ", hl.dsp.exec_cmd(" + luaString(command(pluginId, "toggle"))
        + "), { description = " + luaString(SHELL_DESCRIPTION) + " })";
}

/** Take back the rules, and the key if this shell bound it, while `token` is current. */
function withdrawLua(token, boundSummon) {
    return "if ghost_shell == " + luaString(token) + " then "
        + (boundSummon ? "hl.unbind(" + luaString(SUMMON_KEYS) + "); " : "")
        + ruleLua(false) + "; ghost_shell = nil end";
}

/**
 * The commands focusing the Ghost window with `title`. A Lua config reads a
 * dispatch as a Lua expression and a .conf config only as the classic
 * dispatcher, each refusing the other's, so both are sent, as detached
 * commands whose refusal goes nowhere, and one takes.
 */
function focusCommands(title) {
    var window = "title:" + titlePattern(title);
    return [["hyprctl", "dispatch", "hl.dsp.focus({ window = " + luaString(window) + " })"],
        ["hyprctl", "dispatch", "focuswindow", window]];
}

/** What `hyprctl eval` answers on a .conf config, which has no Lua to run. */
function refusedForConf(answer) {
    return String(answer).indexOf("only supported with the lua config manager") >= 0;
}
