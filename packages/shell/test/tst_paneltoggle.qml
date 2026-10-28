import QtQuick
import QtTest
import Quickshell.Hyprland
import "../qml"
import "../qml/services"

// The toggle with the window left open behind another app: it brings the
// window back as it was, rather than opening the prompt over it.
TestCase {
    name: "PanelToggle"
    when: windowShown

    Component { id: panelComponent; Panel {} }

    function cleanup(): void {
        Presence.dismiss();
        Ghostd.activeGhost = "";
    }

    function test_aPlainSummonRefocusesAnOpenWindow(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        const hud = findChild(panel, "hud");
        panel.open('{"section":"routines"}');
        verify(hud.shown);
        compare(hud.currentSection, "routines");
        // Another app has the focus, so the panel does not count as open.
        verify(!panel.opened);

        Hyprland.dispatched = [];
        panel.open("");
        verify(!Presence.composing);
        compare(hud.currentSection, "routines");
        compare(Hyprland.dispatched, ['hl.dsp.focus({ window = "title:^Ghost$" })']);
    }

    function test_aPlainSummonWithTheWindowClosedOpensThePrompt(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        panel.open("");
        verify(Presence.composing);
    }
}
