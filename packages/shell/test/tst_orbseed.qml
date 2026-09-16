import QtQuick
import QtTest
import "../qml/components/OrbSeed.js" as OrbSeed

TestCase {
    id: tc
    name: "OrbSeed"

    function cellKeys(params): var {
        return params.cells.map(cell => cell.row + "," + cell.column).sort();
    }

    // An orb is a pure function of its two seeds. Everything else here depends
    // on that: a redraw mid-turn must not restyle the ghost, and a test can
    // only assert on an orb it can ask for twice.
    function test_theSameGhostAndTurnDrawTheSameOrb(): void {
        const first = OrbSeed.orb("casper", "pi:sess-1:4", 5);
        const second = OrbSeed.orb("casper", "pi:sess-1:4", 5);
        compare(first.hueShift, second.hueShift);
        compare(first.corePeriod, second.corePeriod);
        compare(first.motes.length, second.motes.length);
        compare(JSON.stringify(first.cells), JSON.stringify(second.cells));
        compare(JSON.stringify(first.motes), JSON.stringify(second.motes));
    }

    // The ghost seed owns what the ghost looks like; the turn seed owns only
    // how it moves. A ghost that changed colour every turn would not be a
    // ghost you recognise.
    function test_aNewTurnChangesTheMotionAndNotTheGhost(): void {
        const earlier = OrbSeed.orb("casper", "pi:sess-1:4", 5);
        const later = OrbSeed.orb("casper", "pi:sess-1:5", 5);
        compare(later.hueShift, earlier.hueShift);
        compare(later.motes.length, earlier.motes.length);
        compare(tc.cellKeys(later).join(" "), tc.cellKeys(earlier).join(" "));
        verify(JSON.stringify(later.motes) !== JSON.stringify(earlier.motes));
        verify(later.cells.some((cell, index) => cell.period !== earlier.cells[index].period));
    }


    // A square grid with its corners kept would draw a block. The disc is what
    // makes it an orb at five columns.

    // A mote walks the rim, so the rim has to be in the order you walk it.
    function test_theRingIsOrderedAsItIsWalked(): void {
        const params = OrbSeed.orb("casper", "pi:sess-1:4", 5);
        verify(params.ring.length >= 8);
        for (let i = 1; i < params.ring.length; i++) {
            verify(params.ring[i].angle >= params.ring[i - 1].angle);
        }
        const centre = (params.grid - 1) / 2;
        for (const seat of params.ring) {
            const distance = Math.sqrt(Math.pow(seat.column - centre, 2)
                + Math.pow(seat.row - centre, 2));
            verify(distance > centre - 0.6);
        }
    }

    // The caller owns the resolution, and the bar widget's orb is smaller than
    // the HUD's. Anything below three columns has no rim to walk.
    function test_theGridNeverFallsBelowThreeColumns(): void {
        compare(OrbSeed.orb("casper", "t", 1).grid, 3);
        compare(OrbSeed.orb("casper", "t", 7).grid, 7);
        verify(OrbSeed.orb("casper", "t", 3).motes.length >= 1);
    }

    // Brightness falls off to the rim, and no cell is ever fully dark: an unlit
    // cell in the middle of a lit disc reads as a dead pixel.
    function test_theCoreIsTheBrightestCellAndNoCellIsBlack(): void {
        const params = OrbSeed.orb("casper", "pi:sess-1:4", 5);
        const centre = params.cells.find(cell => cell.row === 2 && cell.column === 2);
        verify(centre !== undefined);
        for (const cell of params.cells) {
            verify(cell.brightness > 0);
            verify(cell.brightness <= centre.brightness);
        }
    }
}
