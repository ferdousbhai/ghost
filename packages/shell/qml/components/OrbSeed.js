.pragma library

// OrbSeed — the cells of one summoning's orb, and how each of them breathes.
//
// The orb's anatomy is fixed: a disc of phosphor cells on a square grid, bright
// at the core and falling off to the rim, with a mote or three walking the
// outer ring one cell at a time. What varies is everything the eye reads as
// character, and it comes from two seeds because they answer different
// questions:
//
// - the ghost's name fixes the slow traits — where in the spectral band its
//   phosphor sits, how sharply the disc falls off, how many motes it carries.
//   A ghost looks like itself across every conversation, which is the point of
//   having more than one.
// - the turn fixes the motion — how fast each cell breathes and how deeply,
//   where the motes start and which way they walk. The same ghost never
//   flickers the same way twice.
//
// Both are pure functions of their seed, so an orb is reproducible: the same
// ghost and turn always draw the same one. That is what makes it testable, and
// what stops a redraw from restyling itself mid-turn.
//
// The grid is the caller's, not the seed's. At 20px there is room for five
// columns and at 12px for three, and a resolution the seed picked would make
// one ghost legible and another a smudge.

/** FNV-1a, for turning a name into a number without pulling in a dependency. */
function hash(text) {
    let value = 0x811c9dc5;
    const source = String(text || "");
    for (let i = 0; i < source.length; i++) {
        value ^= source.charCodeAt(i);
        value = (value + (value << 1) + (value << 4)
            + (value << 7) + (value << 8) + (value << 24)) >>> 0;
    }
    return value >>> 0;
}

/** xorshift32: a short deterministic stream of 0..1 from one seed. */
function stream(seed) {
    let state = (seed >>> 0) || 0x9e3779b9;
    return function () {
        state ^= (state << 13) >>> 0;
        state >>>= 0;
        state ^= state >>> 17;
        state ^= (state << 5) >>> 0;
        state >>>= 0;
        return state / 4294967296;
    };
}

function between(next, low, high) {
    return low + next() * (high - low);
}

/**
 * The palette sits at 218°, so this band runs from cyan through the orb's own
 * periwinkle to a pale violet. It never leaves the spectral family: a ghost is
 * recognisable by its phosphor, not disguised by it.
 */
var HUE_RANGE = { low: -30, high: 18 };

function orb(ghostName, turnKey, grid) {
    const columns = Math.max(3, Math.round(grid) || 5);
    const slow = stream(hash("ghost " + String(ghostName || "")));
    const fast = stream(hash("turn " + String(ghostName || "")
        + " " + String(turnKey || "")));

    const centre = (columns - 1) / 2;
    const radius = centre + 0.5;
    const falloff = between(slow, 0.8, 1.5);

    const cells = [];
    const ring = [];
    for (let row = 0; row < columns; row++) {
        for (let column = 0; column < columns; column++) {
            const dx = column - centre;
            const dy = row - centre;
            const distance = Math.sqrt(dx * dx + dy * dy);
            // A square grid with the corners taken off is what makes a disc at
            // this resolution; keeping them would draw a block.
            if (distance > radius) continue;
            const near = 1 - Math.min(1, distance / radius);
            cells.push({
                row: row,
                column: column,
                // Floored well above black: an unlit cell inside a lit disc
                // reads as a dead pixel rather than as the rim of something.
                brightness: 0.20 + Math.pow(near, falloff) * 0.76,
                period: Math.round(between(fast, 900, 2100)),
                dim: between(fast, 0.35, 0.72)
            });
            if (distance > radius - 1.05) {
                ring.push({ row: row, column: column, angle: Math.atan2(dy, dx) });
            }
        }
    }
    // Walked in order, so a mote orbits rather than teleporting around the rim.
    ring.sort(function (a, b) { return a.angle - b.angle; });

    const motes = [];
    const moteCount = ring.length === 0 ? 0 : Math.max(1, Math.round(between(slow, 1, 3)));
    for (let i = 0; i < moteCount; i++) {
        motes.push({
            step: Math.floor(between(fast, 0, ring.length)) % ring.length,
            period: Math.round(between(fast, 110, 260)),
            clockwise: fast() < 0.5
        });
    }

    return {
        grid: columns,
        cells: cells,
        ring: ring,
        motes: motes,
        hueShift: between(slow, HUE_RANGE.low, HUE_RANGE.high),
        corePeriod: Math.round(between(fast, 380, 720))
    };
}
