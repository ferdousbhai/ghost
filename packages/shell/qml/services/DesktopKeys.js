.pragma library

// What DesktopKeys.qml asks Hyprland for, as Lua for `hyprctl eval` and
// dispatcher expressions, plus the reading of `hyprctl binds -j` that decides
// whether the summon key is free. Pure, so the decisions are testable.

var SUMMON_KEYS = "SUPER + CTRL + G";
var SUMMON_MODMASK = 64 | 4; // SUPER | CTRL
var SUBMAP = "ghost";
/** The overlays that hold the keyboard; the key mode lasts while one is up. */
var MODAL_LAYERS = ["ghost-hud", "ghost-presence-prompt"];

function command(pluginId, verb) {
    return "omarchy-shell shell " + verb + " " + pluginId;
}

var SUMMON_DESCRIPTION = "Summon ghost";

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

/**
 * The "ghost" key mode, and the hook that leaves it. In the mode the close
 * shortcuts close Ghost instead of the window under it, and the summon key
 * toggles it away; every other shortcut waits until Ghost lets go. The hook
 * is Hyprland's own, so a crashed shell cannot strand the owner without
 * shortcuts: once no modal Ghost layer is mapped, the mode resets.
 */
function submapLua(pluginId) {
    var hide = "hl.dsp.exec_cmd(" + luaString(command(pluginId, "hide")) + ")";
    var toggle = "hl.dsp.exec_cmd(" + luaString(command(pluginId, "toggle")) + ")";
    var layers = MODAL_LAYERS.map(function (name) { return "[" + luaString(name) + "] = true"; }).join(", ");
    return [
        "hl.define_submap(" + luaString(SUBMAP) + ", function()",
        "  hl.bind(\"SUPER + W\", " + hide + ", { description = \"Close ghost\" })",
        "  hl.bind(\"SUPER + Q\", " + hide + ", { description = \"Close ghost\" })",
        "  hl.bind(" + luaString(SUMMON_KEYS) + ", " + toggle + ", { description = \"Close ghost\" })",
        "end)",
        "if ghost_modal_watch then ghost_modal_watch:remove() end",
        "ghost_modal_watch = hl.on(\"layer.closed\", function()",
        "  if hl.get_current_submap() ~= " + luaString(SUBMAP) + " then return end",
        "  local modal = { " + layers + " }",
        "  for _, layer in ipairs(hl.get_layers()) do",
        "    if modal[layer.namespace] then return end",
        "  end",
        "  hl.dispatch(hl.dsp.submap(\"reset\"))",
        "end)",
    ].join("\n");
}

/** The dispatcher expression entering or leaving the key mode. */
function submapDispatch(active) {
    return "hl.dsp.submap(" + luaString(active ? SUBMAP : "reset") + ")";
}
