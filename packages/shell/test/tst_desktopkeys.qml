import QtQuick
import QtTest
import "../qml/services/DesktopKeys.js" as Desk

// What Ghost asks of Hyprland at runtime: the summon key, claimed only when
// free, and the rules that keep its keyboard windows over the desktop.
TestCase {
    name: "DesktopKeys"

    readonly property string id: "ferdousbhai.ghost"

    function test_theSummonKeyIsClaimedOnlyWhenFree(): void {
        compare(Desk.summonKeyState([], id), "free");
        compare(Desk.summonKeyState([{ modmask: 64, key: "G", submap: "" }], id), "free");
        compare(Desk.summonKeyState([{ modmask: 68, key: "G", submap: "", arg: "omarchy-shell shell toggle ferdousbhai.ghost" }], id), "ours");
        compare(Desk.summonKeyState([{ modmask: 68, key: "g", submap: "", arg: "some-other-app" }], id), "taken");
        // An earlier claim from Lua lists a function number, not the command.
        compare(Desk.summonKeyState([{ modmask: 68, key: "G", submap: "", arg: "12", description: "Summon ghost" }], id), "ours");
        // A bind inside another key mode does not hold the key in the default one.
        compare(Desk.summonKeyState([{ modmask: 68, key: "G", submap: "resize", arg: "x" }], id), "free");
        compare(Desk.summonKeyState(null, id), "free");
    }

    function test_theSummonBindTogglesThePlugin(): void {
        const lua = Desk.summonBindLua(id);
        verify(lua.startsWith('hl.bind("SUPER + CTRL + G", hl.dsp.exec_cmd("omarchy-shell shell toggle ferdousbhai.ghost")'));
        compare(Desk.summonUnbindLua(), 'hl.unbind("SUPER + CTRL + G")');
    }

    // Ghost's keyboard windows: found by title (with the host's app-id), kept
    // floating over the tiling at their monitor's size, pinned, undecorated.
    function test_theWindowRulesFindAndShapeGhostsWindows(): void {
        const lua = Desk.windowRulesLua();
        verify(lua.indexOf('hl.window_rule({ name = "ghost-windows"') === 0);
        // Lua source: an escaped backslash, so Hyprland's pattern is ^org\.quickshell$.
        verify(lua.indexOf('class = "^org\\\\.quickshell$"') > 0);
        verify(lua.indexOf('title = "^(Ghost|Ghost prompt)$"') > 0);
        for (const effect of ["float = true", "pin = true", 'size = { "monitor_w", "monitor_h" }', "move = { 0, 0 }",
            "border_size = 0", "rounding = 0", "no_shadow = true", 'tag = "-default-opacity"'])
            verify(lua.indexOf(effect) > 0, effect);
    }

    function test_focusFindsAWindowByItsWholeTitle(): void {
        compare(Desk.focusDispatch(Desk.HUD_TITLE), 'hl.dsp.focus({ window = "title:^Ghost$" })');
        compare(Desk.titlePattern("a.b (c)"), "^a\\.b \\(c\\)$");
    }
}
