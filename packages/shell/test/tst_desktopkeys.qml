import QtQuick
import QtTest
import Quickshell
import Quickshell.Hyprland
import "../qml"
import "../qml/services/DesktopKeys.js" as Desk

// What Ghost asks of Hyprland at runtime: the summon key, claimed only when
// free, the rules that keep its keyboard windows over the desktop, and taking
// both back.
TestCase {
    id: tc
    name: "DesktopKeys"
    when: windowShown

    readonly property string id: "ferdousbhai.ghost"

    Component {
        id: keysComponent
        DesktopKeys {}
    }

    function test_whoHoldsTheSummonKey(): void {
        compare(Desk.summonKeyState([], id), "free");
        compare(Desk.summonKeyState([{ modmask: 64, key: "G", submap: "" }], id), "free");
        compare(Desk.summonKeyState([{ modmask: 68, key: "G", submap: "", arg: "omarchy-shell shell toggle ferdousbhai.ghost" }], id), "owner");
        // The contrib snippet's bind, made from Lua, lists a function number.
        compare(Desk.summonKeyState([{ modmask: 68, key: "G", submap: "", arg: "12", description: "Summon ghost" }], id), "owner");
        // An earlier claim by the shell is the shell's to take over.
        compare(Desk.summonKeyState([{ modmask: 68, key: "G", submap: "", arg: "13", description: "Summon ghost (shell)" }], id), "shell");
        compare(Desk.summonKeyState([{ modmask: 68, key: "g", submap: "", arg: "some-other-app" }], id), "taken");
        // A bind inside another key mode does not hold the key in the default one.
        compare(Desk.summonKeyState([{ modmask: 68, key: "G", submap: "resize", arg: "x" }], id), "free");
        compare(Desk.summonKeyState(null, id), "free");
    }

    function test_theSummonBindReplacesAnyEarlierClaim(): void {
        compare(Desk.summonBindLua(id), 'hl.unbind("SUPER + CTRL + G"); hl.bind("SUPER + CTRL + G", '
            + 'hl.dsp.exec_cmd("omarchy-shell shell toggle ferdousbhai.ghost"), { description = "Summon ghost (shell)" })');
    }

    // Ghost's keyboard windows: found by title (with the host's app-id), kept
    // floating over the tiling at their monitor's size, pinned, undecorated.
    function test_theWindowRulesFindAndShapeGhostsWindows(): void {
        const lua = Desk.setUpLua("t1");
        verify(lua.indexOf('ghost_shell = "t1"; hl.window_rule({ name = "ghost-windows"') === 0);
        // Lua source: an escaped backslash, so Hyprland's pattern is ^org\.quickshell$.
        verify(lua.indexOf('class = "^org\\\\.quickshell$"') > 0);
        verify(lua.indexOf('title = "^(Ghost|Ghost prompt)$"') > 0);
        for (const effect of ["float = true", "pin = true", 'size = { "monitor_w", "monitor_h" }', "move = { 0, 0 }",
            "border_size = 0", "rounding = 0", "no_shadow = true", 'tag = "-default-opacity"'])
            verify(lua.indexOf(effect) > 0, effect);
    }

    // The way out: only while this shell's setup is current, and the key only
    // when this shell bound it.
    function test_withdrawingTakesBackOnlyWhatThisShellMade(): void {
        const both = Desk.withdrawLua("t1", true);
        verify(both.indexOf('if ghost_shell == "t1" then hl.unbind("SUPER + CTRL + G"); hl.window_rule({ name = "ghost-windows", enabled = false') === 0);
        verify(both.endsWith("ghost_shell = nil end"));
        verify(Desk.withdrawLua("t1", false).indexOf("hl.unbind") < 0);
    }

    function test_focusFindsAWindowByItsWholeTitle(): void {
        compare(Desk.focusDispatches(Desk.HUD_TITLE), ['hl.dsp.focus({ window = "title:^Ghost$" })', "focuswindow title:^Ghost$"]);
        compare(Desk.titlePattern("a.b (c)"), "^a\\.b \\(c\\)$");
    }

    function answerProbe(keys: var, binds: var): void {
        const probe = findChild(keys, "bindsProbe");
        verify(probe.running);
        probe.stdout.text = JSON.stringify(binds);
        probe.stdout.streamFinished();
        probe.simulateExited(0, 0);
    }

    // Mounted: a free key is claimed, the claim is withdrawn on unload, and a
    // config reload during a read reads again rather than trusting the old one.
    function test_aFreeKeyIsClaimedAndGivenBack(): void {
        const keys = createTemporaryObject(keysComponent, tc);
        const evaluator = findChild(keys, "evaluator");
        compare(evaluator.command[2], Desk.setUpLua(keys.token));
        answerProbe(keys, []);
        compare(keys.summonKey, "shell");
        verify(keys.boundSummon);
        evaluator.simulateExited(0, 0);
        wait(0);
        verify(evaluator.running);
        compare(evaluator.command[2], Desk.summonBindLua(id));

        const token = keys.token;
        Quickshell.detached = [];
        keys.destroy();
        wait(0);
        compare(Quickshell.detached.length, 1);
        compare(Quickshell.detached[0][2], Desk.withdrawLua(token, true));
    }

    function test_theOwnersBindIsLeftAlone(): void {
        const keys = createTemporaryObject(keysComponent, tc);
        answerProbe(keys, [{ modmask: 68, key: "G", submap: "", arg: "1", description: "Summon ghost" }]);
        compare(keys.summonKey, "owner");
        verify(!keys.boundSummon);
        compare(keys.pending.length, 0);
    }

    function test_aReloadDuringAReadReadsAgain(): void {
        const keys = createTemporaryObject(keysComponent, tc);
        Hyprland.rawEvent({ name: "configreloaded", data: "" });
        answerProbe(keys, [{ modmask: 68, key: "G", submap: "", arg: "1", description: "Summon ghost (shell)" }]);
        // The read straddled a reload: it is not trusted, and a new one runs.
        compare(keys.summonKey, "");
        wait(0);
        answerProbe(keys, []);
        compare(keys.summonKey, "shell");
    }

    // Unloading with a chunk still queued sends it ahead of the withdrawal.
    function test_aQueuedChunkLandsBeforeTheWithdrawal(): void {
        const keys = createTemporaryObject(keysComponent, tc);
        answerProbe(keys, []);
        compare(keys.pending, [Desk.summonBindLua(id)]);
        const token = keys.token;
        Quickshell.detached = [];
        keys.destroy();
        wait(0);
        compare(Quickshell.detached[0][2], Desk.summonBindLua(id) + "; " + Desk.withdrawLua(token, true));
    }

    // A reload drops what was queued for the configuration before it.
    function test_aReloadDropsStaleChunks(): void {
        const keys = createTemporaryObject(keysComponent, tc);
        answerProbe(keys, []);
        compare(keys.pending, [Desk.summonBindLua(id)]);
        Hyprland.rawEvent({ name: "configreloaded", data: "" });
        compare(keys.pending, [Desk.setUpLua(keys.token)]);
    }

    // A .conf config refuses Lua: the shell stops asking, and says the key is
    // free but unbound rather than claiming it holds it.
    function test_aConfConfigIsNotAskedForLua(): void {
        const keys = createTemporaryObject(keysComponent, tc);
        const evaluator = findChild(keys, "evaluator");
        evaluator.stdout.text = "eval is only supported with the lua config manager";
        evaluator.stdout.streamFinished();
        evaluator.simulateExited(0, 0);
        verify(!keys.lua);
        answerProbe(keys, []);
        compare(keys.summonKey, "none");
        verify(!keys.boundSummon);
        compare(keys.pending.length, 0);
        Quickshell.detached = [];
        keys.destroy();
        wait(0);
        compare(Quickshell.detached.length, 0);
    }
}
