import QtQuick
import QtTest
import "../qml/services/DesktopKeys.js" as Keys

// Ghost's runtime shortcuts: the summon key is claimed only when free, and
// the "ghost" key mode closes Ghost rather than the window under it and
// resets itself once no modal Ghost layer is mapped.
TestCase {
    name: "DesktopKeys"

    readonly property string id: "ferdousbhai.ghost"

    function test_theSummonKeyIsClaimedOnlyWhenFree(): void {
        compare(Keys.summonKeyState([], id), "free");
        compare(Keys.summonKeyState([{ modmask: 64, key: "G", submap: "" }], id), "free");
        compare(Keys.summonKeyState([{ modmask: 68, key: "G", submap: "", arg: "omarchy-shell shell toggle ferdousbhai.ghost" }], id), "ours");
        compare(Keys.summonKeyState([{ modmask: 68, key: "g", submap: "", arg: "some-other-app" }], id), "taken");
        // An earlier claim from Lua lists a function number, not the command.
        compare(Keys.summonKeyState([{ modmask: 68, key: "G", submap: "", arg: "12", description: "Summon ghost" }], id), "ours");
        // A bind inside another key mode does not hold the key in the default one.
        compare(Keys.summonKeyState([{ modmask: 68, key: "G", submap: "resize", arg: "x" }], id), "free");
        compare(Keys.summonKeyState(null, id), "free");
    }

    function test_theSummonBindTogglesThePlugin(): void {
        const lua = Keys.summonBindLua(id);
        verify(lua.startsWith('hl.bind("SUPER + CTRL + G", hl.dsp.exec_cmd("omarchy-shell shell toggle ferdousbhai.ghost")'));
        compare(Keys.summonUnbindLua(), 'hl.unbind("SUPER + CTRL + G")');
    }

    function test_theKeyModeClosesGhostAndResetsItself(): void {
        const lua = Keys.submapLua(id);
        verify(lua.indexOf('hl.define_submap("ghost", function()') === 0);
        verify(lua.indexOf('hl.bind("SUPER + W", hl.dsp.exec_cmd("omarchy-shell shell hide ferdousbhai.ghost")') > 0);
        verify(lua.indexOf('hl.bind("SUPER + Q", hl.dsp.exec_cmd("omarchy-shell shell hide ferdousbhai.ghost")') > 0);
        // One watcher however often it is set up, keyed to the modal layers.
        verify(lua.indexOf("if ghost_modal_watch then ghost_modal_watch:remove() end") > 0);
        verify(lua.indexOf('["ghost-hud"] = true, ["ghost-presence-prompt"] = true') > 0);
        verify(lua.indexOf('hl.dispatch(hl.dsp.submap("reset"))') > 0);
        compare(Keys.submapDispatch(true), 'hl.dsp.submap("ghost")');
        compare(Keys.submapDispatch(false), 'hl.dsp.submap("reset")');
    }
}
