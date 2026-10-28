import QtQuick
import QtTest
import Quickshell
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

        Quickshell.detached = [];
        panel.open("");
        verify(!Presence.composing);
        compare(hud.currentSection, "routines");
        compare(Quickshell.detached, [["hyprctl", "dispatch", 'hl.dsp.focus({ window = "title:^Ghost$" })'],
            ["hyprctl", "dispatch", "focuswindow", "title:^Ghost$"]]);
    }

    // Naming a ghost with the prompt left behind another app brings the
    // prompt back, asking that ghost.
    function test_summoningANamedGhostRefocusesAnOpenPrompt(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        panel.open("");
        Quickshell.detached = [];
        panel.open('{"ghost":"dous"}');
        verify(Presence.composing);
        compare(Quickshell.detached.length, 2);
        compare(Quickshell.detached[1], ["hyprctl", "dispatch", "focuswindow", "title:^Ghost prompt$"]);
    }

    // Naming a ghost still asks that ghost, window open or not.
    function test_summoningANamedGhostOpensItsPrompt(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        panel.open('{"section":"routines"}');
        panel.open('{"ghost":"dous"}');
        verify(Presence.composing);
    }

    function test_aPlainSummonRefocusesAnOpenPrompt(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        panel.open("");
        verify(Presence.composing);
        verify(!panel.opened);
        Quickshell.detached = [];
        panel.open("");
        verify(Presence.composing);
        compare(Quickshell.detached, [["hyprctl", "dispatch", 'hl.dsp.focus({ window = "title:^Ghost prompt$" })'],
            ["hyprctl", "dispatch", "focuswindow", "title:^Ghost prompt$"]]);
    }

    function test_aPlainSummonWithTheWindowClosedOpensThePrompt(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        panel.open("");
        verify(Presence.composing);
    }
}
