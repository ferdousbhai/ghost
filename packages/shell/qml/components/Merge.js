.pragma library

// A line-based three-way merge: base, mine, theirs in, one text out.
//
// The workbench keeps a file open while the ghost is writing to it. Most of the
// time the two of you are nowhere near each other — you are typing at the
// bottom of a document while a tool rewrites a section at the top — and asking
// "keep mine or take theirs?" for that is asking the user to arbitrate a fight
// that never happened. So the pane merges first and only asks when the same
// lines genuinely moved on both sides.
//
// The unit is a line, not a character: documents and code files are line-shaped,
// and a character-level merge would silently interleave two rewrites of one
// sentence into something neither side wrote. Lines carry their own "\n", so a
// file with no trailing newline differs from one with it *on that line* and
// nothing has to remember a flag; concatenating the line array is the exact
// original bytes back.
//
// The one hard invariant, pinned in test/tst_merge.qml: every line of the result
// is a line of base, mine or theirs, emitted by slicing those arrays. No branch
// joins, trims, or re-splits a line, so a clean merge cannot invent or lose a
// character.

// Two ceilings, both of them a deliberate "give up and let the user decide"
// rather than a stall. A HUD pane must not spend a visible pause diffing, and
// the LCS table below is O(n*m) in both time and memory: a full-file rewrite of
// a large file is exactly the case where a merge would be least trustworthy
// anyway. Past either bound the pane falls back to the conflict prompt.
const MAX_LINES = 20000;
const MAX_CELLS = 2000000;

const CONFLICT = { ok: false, text: "" };

function text(value) {
    return String(value === undefined || value === null ? "" : value);
}

/**
 * Split into lines that each keep their own trailing "\n" (the last one has
 * none when the text does not end in a newline). `lines.join("")` is the input
 * verbatim, and "" splits to [].
 */
function splitLines(source) {
    const out = [];
    const length = source.length;
    let start = 0;
    for (let at = 0; at < length; at++) {
        if (source.charCodeAt(at) === 10) {
            out.push(source.slice(start, at + 1));
            start = at + 1;
        }
    }
    if (start < length) out.push(source.slice(start));
    return out;
}


/**
 * Matched line pairs [aIndex, bIndex] in increasing order — a longest common
 * subsequence of the two line arrays. Returns null when the table would be
 * bigger than MAX_CELLS.
 *
 * The common prefix and suffix are matched off first. That is not only the
 * speed-up that keeps the table small for the usual edit-in-a-big-file case; it
 * also anchors the diff at the ends, which is what stops an LCS from "matching"
 * a stray brace line half a file away from where it belongs.
 */
function matchPairs(a, b) {
    const shorter = Math.min(a.length, b.length);

    let prefix = 0;
    while (prefix < shorter && a[prefix] === b[prefix]) prefix++;

    let suffix = 0;
    while (suffix < shorter - prefix
        && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

    const rows = a.length - prefix - suffix;
    const cols = b.length - prefix - suffix;
    if ((rows + 1) * (cols + 1) > MAX_CELLS) return null;

    // table[i][j] = length of the LCS of a[prefix+i..] and b[prefix+j..],
    // filled from the end so the walk below can go forwards.
    const width = cols + 1;
    const table = new Uint32Array((rows + 1) * width);
    for (let i = rows - 1; i >= 0; i--) {
        for (let j = cols - 1; j >= 0; j--) {
            table[i * width + j] = a[prefix + i] === b[prefix + j]
                ? table[(i + 1) * width + j + 1] + 1
                : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
        }
    }

    const pairs = [];
    for (let k = 0; k < prefix; k++) pairs.push([k, k]);
    let i = 0;
    let j = 0;
    while (i < rows && j < cols) {
        if (a[prefix + i] === b[prefix + j]) {
            pairs.push([prefix + i, prefix + j]);
            i++;
            j++;
        } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
            i++;
        } else {
            j++;
        }
    }
    for (let k = 0; k < suffix; k++) {
        pairs.push([a.length - suffix + k, b.length - suffix + k]);
    }
    return pairs;
}

/**
 * The gaps between matches: {aStart, aEnd, bStart, bEnd} regions where `b`
 * replaced a[aStart..aEnd) with b[bStart..bEnd). Ranges are half-open and
 * sorted, and either side of one may be empty (a pure insertion or deletion).
 */
function changeHunks(a, b) {
    const pairs = matchPairs(a, b);
    if (pairs === null) return null;

    const hunks = [];
    let ai = 0;
    let bi = 0;
    for (const pair of pairs) {
        if (pair[0] > ai || pair[1] > bi) {
            hunks.push({ aStart: ai, aEnd: pair[0], bStart: bi, bEnd: pair[1] });
        }
        ai = pair[0] + 1;
        bi = pair[1] + 1;
    }
    if (ai < a.length || bi < b.length) {
        hunks.push({ aStart: ai, aEnd: a.length, bStart: bi, bEnd: b.length });
    }
    return hunks;
}


function isInsertion(hunk) {
    return hunk.aStart === hunk.aEnd;
}

/**
 * Does `hunk` belong to the group already covering base range [lo, hi)?
 *
 * Ranges are half-open, so the interval test alone never pulls in a pure
 * insertion — which is right at the *edges* of a changed region (an insertion
 * at `lo` goes before it, one at `hi` after it, and both orders are agreed by
 * the two sides) and wrong for two insertions at the same point, which is the
 * `insertionPoint` case: same-boundary insertions are grouped so they can be
 * collapsed if identical and refused if not. Nothing here guesses an order for
 * two different insertions at one boundary.
 */
function joinsGroup(hunk, lo, hi, insertionPoint) {
    if (hunk.aStart < hi && hunk.aEnd > lo) return true;
    if (insertionPoint) return hunk.aStart === lo && isInsertion(hunk);
    return false;
}

function pushRange(out, lines, from, to) {
    for (let at = from; at < to; at++) out.push(lines[at]);
}

function sameRange(a, aFrom, aTo, b, bFrom, bTo) {
    if (aTo - aFrom !== bTo - bFrom) return false;
    for (let at = 0; at < aTo - aFrom; at++) {
        if (a[aFrom + at] !== b[bFrom + at]) return false;
    }
    return true;
}

/**
 * Merge `mine` and `theirs`, both descended from `base`.
 *
 * Returns {ok, text}. `ok: false` means at least one hunk changed the same
 * base lines on both sides in different ways, or the inputs were past the size
 * ceilings; `text` is only meaningful when `ok` is true.
 *
 * Hunk semantics: changes over disjoint base regions both apply; the same
 * change on both sides collapses to one; anything else that overlaps is a
 * conflict for the whole merge, not just for that region — there is no
 * conflict-marker output here, because the pane's fallback is to show the user
 * both files and ask, not to paste "<<<<<<<" into a document.
 */
function merge(base, mine, theirs) {
    const baseText = text(base);
    const mineText = text(mine);
    const theirsText = text(theirs);

    // The three cheap answers, taken before any splitting so that two big
    // identical files never touch the table.
    if (mineText === theirsText) return { ok: true, text: mineText };
    if (baseText === mineText) return { ok: true, text: theirsText };
    if (baseText === theirsText) return { ok: true, text: mineText };

    const baseLines = splitLines(baseText);
    const mineLines = splitLines(mineText);
    const theirsLines = splitLines(theirsText);
    if (baseLines.length > MAX_LINES || mineLines.length > MAX_LINES
        || theirsLines.length > MAX_LINES) return CONFLICT;

    const mineHunks = changeHunks(baseLines, mineLines);
    const theirsHunks = changeHunks(baseLines, theirsLines);
    if (mineHunks === null || theirsHunks === null) return CONFLICT;

    const out = [];
    // Cursors into the three arrays, all naming the same point in the file.
    let baseAt = 0;
    let mineAt = 0;
    let theirsAt = 0;
    let x = 0;
    let y = 0;

    while (x < mineHunks.length || y < theirsHunks.length) {
        // Seed the group with the earliest remaining hunk. A tie goes to a pure
        // insertion, because it sits before the base line the other side's
        // replacement covers — the one order both sides already agree on, and
        // the reason a skipped hunk can never start behind `baseAt`.
        const nextMine = x < mineHunks.length ? mineHunks[x] : null;
        const nextTheirs = y < theirsHunks.length ? theirsHunks[y] : null;
        let seedMine;
        if (nextMine === null) seedMine = false;
        else if (nextTheirs === null) seedMine = true;
        else if (nextMine.aStart !== nextTheirs.aStart) {
            seedMine = nextMine.aStart < nextTheirs.aStart;
        } else {
            seedMine = isInsertion(nextMine) || !isInsertion(nextTheirs);
        }

        const seed = seedMine ? mineHunks[x++] : theirsHunks[y++];
        const lo = seed.aStart;
        let hi = seed.aEnd;
        let mineCount = seedMine ? 1 : 0;
        let theirsCount = seedMine ? 0 : 1;
        let mineDelta = seedMine ? (seed.bEnd - seed.bStart) - (seed.aEnd - seed.aStart) : 0;
        let theirsDelta = seedMine ? 0 : (seed.bEnd - seed.bStart) - (seed.aEnd - seed.aStart);

        // Grow until nothing more meets the range. Two passes are not enough:
        // a hunk pulled in from one side can widen the range onto a hunk of the
        // other, which is exactly how two interleaved rewrites become one
        // conflict rather than a plausible-looking splice.
        let grew = true;
        while (grew) {
            grew = false;
            while (x < mineHunks.length
                && joinsGroup(mineHunks[x], lo, hi, hi === lo)) {
                const hunk = mineHunks[x++];
                hi = Math.max(hi, hunk.aEnd);
                mineDelta += (hunk.bEnd - hunk.bStart) - (hunk.aEnd - hunk.aStart);
                mineCount++;
                grew = true;
            }
            while (y < theirsHunks.length
                && joinsGroup(theirsHunks[y], lo, hi, hi === lo)) {
                const hunk = theirsHunks[y++];
                hi = Math.max(hi, hunk.aEnd);
                theirsDelta += (hunk.bEnd - hunk.bStart) - (hunk.aEnd - hunk.aStart);
                theirsCount++;
                grew = true;
            }
        }

        // Untouched base lines ahead of the group, emitted from base: all three
        // texts hold the same bytes there.
        pushRange(out, baseLines, baseAt, lo);
        mineAt += lo - baseAt;
        theirsAt += lo - baseAt;
        baseAt = lo;

        // No hunk of either side crosses lo or hi — the group grew until that
        // was true — so the group's span on each side is the base span plus
        // that side's own length change inside it.
        const mineEnd = mineAt + (hi - lo) + mineDelta;
        const theirsEnd = theirsAt + (hi - lo) + theirsDelta;

        if (mineCount === 0) {
            pushRange(out, theirsLines, theirsAt, theirsEnd);
        } else if (theirsCount === 0) {
            pushRange(out, mineLines, mineAt, mineEnd);
        } else if (sameRange(mineLines, mineAt, mineEnd,
            theirsLines, theirsAt, theirsEnd)) {
            pushRange(out, mineLines, mineAt, mineEnd);
        } else {
            return CONFLICT;
        }

        baseAt = hi;
        mineAt = mineEnd;
        theirsAt = theirsEnd;
    }

    pushRange(out, baseLines, baseAt, baseLines.length);
    return { ok: true, text: out.join("") };
}
