.pragma library

// What DesktopKeys.qml asks Hyprland for, as Lua for `hyprctl eval` and
// dispatcher expressions, plus the reading of `hyprctl binds -j` that decides
// whether the summon key is free. Pure, so the decisions are testable.

var SUMMON_KEYS = "SUPER + CTRL + G";
var SUMMON_MODMASK = 64 | 4; // SUPER | CTRL
var SUMMON_DESCRIPTION = "Summon ghost";

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
 * Whether the summon key is free: "free", "ours" (already bound to this
 * plugin, by the contrib snippet or an earlier claim), or "taken" (by
 * something else, which is left alone). A bind made from Lua lists a
 * function number as its argument, so an earlier claim is known by its
 * description.
 */
function summonKeyState(binds, pluginId) {
    var list = Array.isArray(binds) ? binds : [];
    for (var i = 0; i < list.length; i++) {
        var bind = list[i] || {};
        if ((bind.submap || "") !== "") continue;
        if (bind.modmask !== SUMMON_MODMASK || String(bind.key || "").toLowerCase() !== "g") continue;
        var ours = String(bind.arg || "").indexOf(pluginId) >= 0 || bind.description === SUMMON_DESCRIPTION;
        return ours ? "ours" : "taken";
    }
    return "free";
}

function luaString(text) {
    return JSON.stringify(String(text));
}

/** Bind the summon key in the default key mode. */
function summonBindLua(pluginId) {
    return "hl.bind(" + luaString(SUMMON_KEYS) + ", hl.dsp.exec_cmd(" + luaString(command(pluginId, "toggle"))
        + "), { description = " + luaString(SUMMON_DESCRIPTION) + " })";
}

function summonUnbindLua() {
    return "hl.unbind(" + luaString(SUMMON_KEYS) + ")";
}

/** A title as a whole-string pattern for a window rule or focus request. */
function titlePattern(title) {
    return "^" + String(title).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
}

/**
 * How Hyprland keeps Ghost's keyboard windows: floating over the tiling, the
 * size of their monitor from its corner, pinned across workspaces, with no
 * border, rounding, shadow or open animation of their own (they draw their own
 * scrim and card, and animate them), and out of Omarchy's default inactive
 * opacity. Named, so a re-run after a config reload replaces rather than adds.
 */
function windowRulesLua() {
    var title = "^(" + [HUD_TITLE, PROMPT_TITLE].map(function (name) {
        return titlePattern(name).slice(1, -1);
    }).join("|") + ")$";
    return "hl.window_rule({ name = \"ghost-windows\", match = { class = " + luaString(HOST_CLASS)
        + ", title = " + luaString(title) + " }, float = true, pin = true,"
        + " size = { \"monitor_w\", \"monitor_h\" }, move = { 0, 0 },"
        + " border_size = 0, rounding = 0, no_shadow = true, no_anim = true,"
        + " opacity = \"1 1\", tag = \"-default-opacity\" })";
}

/** The dispatcher expression focusing the Ghost window with `title`. */
function focusDispatch(title) {
    return "hl.dsp.focus({ window = " + luaString("title:" + titlePattern(title)) + " })";
}
