import QtQuick
import QtTest
import "../qml/components"
import "../qml/services"

// `picked` closes the open file because it belonged to the ghost just left.
// Backing out of naming a new ghost leaves no ghost, so it must not.
TestCase {
    name: "RosterSummon"
    when: windowShown
    width: 300
    height: 400
    visible: true

    Roster {
        id: roster
        width: 300
    }

    SignalSpy { id: picked; target: roster; signalName: "picked" }
    SignalSpy { id: refocused; target: roster; signalName: "refocused" }

    function test_cancellingASummonOnlyRefocuses(): void {
        Ghostd.ghosts = [{ name: "casper", dir: "/tmp/ghosts/casper" }];
        roster.naming = true;
        const field = findChild(roster, "summonName");
        tryVerify(() => field !== null && field.visible);
        field.forceActiveFocus();
        keyClick(Qt.Key_Escape);
        verify(!roster.naming);
        compare(picked.count, 0);
        compare(refocused.count, 1);
    }
}
