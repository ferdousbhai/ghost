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
        Dictation.state = "";
    }

    // The menu listens as it opens on its list, and stops when the list goes:
    // a transcript must not type into a pane.
    function test_theMenuListensWhileItsListIsUp(): void {
        Ghostd.activeGhost = "dous";
        Dictation.state = "idle";
        const panel = createTemporaryObject(panelComponent, this);
        const hud = findChild(panel, "hud");
        panel.open('{"section":"home"}');
        verify(hud.listening);
        hud.showSection("board");
        verify(!hud.listening);
    }

    // Putting the window back after a reload is not the owner summoning it.
    function test_aRestoreNeitherListensNorIgnites(): void {
        Ghostd.activeGhost = "dous";
        Dictation.state = "idle";
        const panel = createTemporaryObject(panelComponent, this);
        const before = Presence.ignitions;
        panel.open('{"section":"home","restore":true}');
        verify(findChild(panel, "hud").shown);
        verify(!findChild(panel, "hud").listening);
        compare(Presence.ignitions, before);
    }

    function test_theMenuOpenedOnAPaneDoesNotListen(): void {
        Ghostd.activeGhost = "dous";
        Dictation.state = "idle";
        const panel = createTemporaryObject(panelComponent, this);
        panel.open('{"section":"board"}');
        verify(!findChild(panel, "hud").listening);
    }

    // The menu's glow starts from where the bar mark was clicked.
    function test_theMenuIgnitesFromTheClick(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        const before = Presence.ignitions;
        Presence.clickedAt = { screen: "DP-1", edge: "top", at: 0.93, time: Date.now() };
        panel.open('{"section":"home"}');
        compare(Presence.ignitions, before + 1);
        compare(Presence.ignitionScreen, "DP-1");
        compare(Presence.ignitionEdge, "top");
        compare(Presence.ignitionAt, 0.93);
        compare(Presence.hudScreen, "DP-1");
        verify(Presence.clickedAt === null);
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

    // Bringing the prompt back keeps the owner's choice of a new conversation.
    function test_refocusKeepsTheChoiceOfANewConversation(): void {
        Ghostd.activeGhost = "dous";
        const panel = createTemporaryObject(panelComponent, this);
        panel.open("");
        Presence.phase = "answered";
        Presence.ghost = "dous";
        Presence.continuing = false;
        panel.open('{"ghost":"dous"}');
        verify(!Presence.continuing);
        Presence.phase = "";
        Presence.ghost = "";
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
