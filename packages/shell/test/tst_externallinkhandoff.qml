import QtQuick
import QtTest
import "../qml/services"

// The takeover makes way when something outside Ghost opens: a link or a
// file handed to the desktop says so. A refused one opens nothing, so it
// takes nothing away from the owner.
TestCase {
    name: "ExternalLinkHandoff"

    SignalSpy {
        id: handoffs
        target: ExternalLinks
        signalName: "handedOff"
    }

    function init(): void {
        handoffs.clear();
    }

    function test_anOpenedLinkOrPathHandsOff(): void {
        ExternalLinks.openModelUrl("https://example.com/docs");
        ExternalLinks.openPath("/home/u/notes/board.md");
        compare(handoffs.count, 2);
    }

    function test_aRefusedOneDoesNot(): void {
        ignoreWarning("ghost shell rejected an unsafe model-authored URL");
        ExternalLinks.openModelUrl("javascript:alert(1)");
        ignoreWarning("ghost shell rejected an unopenable local path");
        ExternalLinks.openPath("relative/path");
        compare(handoffs.count, 0);
    }
}
