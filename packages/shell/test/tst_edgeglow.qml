import QtQuick
import QtTest
import "../qml/services/EdgeGlow.js" as EdgeGlow

// The edge glow is one ring round the screen: positions run clockwise from
// the top-left corner, an ignition lights it outward both ways from where the
// summon came from, and the ring is whole once the fronts meet opposite it.
TestCase {
    name: "EdgeGlow"

    readonly property var palette: [Qt.rgba(1, 0.75, 0.14, 1), Qt.rgba(0.98, 0.44, 0.52, 1), Qt.rgba(0.3, 0.5, 1, 1)]

    function test_theRingRunsClockwise(): void {
        // 100 wide, 50 tall: a ring of 300.
        compare(EdgeGlow.ringAt("top", 30, 100, 50), 30);
        compare(EdgeGlow.ringAt("right", 10, 100, 50), 110);
        compare(EdgeGlow.ringAt("bottom", 100, 100, 50), 150);
        compare(EdgeGlow.ringAt("left", 0, 100, 50), 300);
        compare(EdgeGlow.origin("top", 0.9, 100, 50), 90);
        compare(EdgeGlow.origin("bottom", 0.5, 100, 50), 200);
        compare(EdgeGlow.origin("left", 0.5, 100, 50), 275);
    }

    function test_reachIsTheShorterWayRound(): void {
        compare(EdgeGlow.reach(10, 10, 300), 0);
        compare(EdgeGlow.reach(160, 10, 300), 1);
        // 280 from 10 is 30 the other way round.
        fuzzyCompare(EdgeGlow.reach(280, 10, 300), 30 / 150, 1e-9);
    }

    function test_anIgnitionLightsOutwardFromItsOrigin(): void {
        const at = s => EdgeGlow.glowAt(s, 300, 90, 0.4, 0, 0, palette).a;
        // Near the origin, both ways round, it is lit; opposite, not yet.
        verify(at(90) > 0.99);
        verify(at(70) > 0.99 && at(110) > 0.99);
        compare(at(240), 0);
        // Once the front has gone all the way, the whole ring is lit.
        verify(EdgeGlow.glowAt(240, 300, 90, 1, 0, 0, palette).a > 0.99);
    }

    function test_theFrontsCarryABrightHead(): void {
        // The head sits at the front; with a flare it is near white and visible
        // even where the lit region has not yet reached full strength.
        const front = 0.5, d = front * 1.12, s = 90 + d * 150;
        const head = EdgeGlow.glowAt(s, 300, 90, front, 1, 0, palette);
        const plain = EdgeGlow.glowAt(s, 300, 90, front, 0, 0, palette);
        verify(head.a > 0.99);
        verify(plain.a < 0.1);
        verify(head.r > 0.6 && head.g > 0.6 && head.b > 0.6);
    }

    function test_theColoursTurnRoundTheRing(): void {
        const a = EdgeGlow.glowAt(0, 300, 0, 1, 0, 0, palette);
        const b = EdgeGlow.glowAt(0, 300, 0, 1, 0, 0.25, palette);
        verify(Math.abs(a.r - b.r) + Math.abs(a.g - b.g) + Math.abs(a.b - b.b) > 0.05);
        // The palette wraps: a whole turn is where it began.
        const c = EdgeGlow.glowAt(0, 300, 0, 1, 0, 1, palette);
        fuzzyCompare(c.r, a.r, 1e-6);
    }
}
